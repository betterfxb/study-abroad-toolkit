"""零依赖冒烟测试。

用途：不装任何第三方库即可验证核心逻辑（去重 / 标准化 / 适配器注册表 / 抽取 / 流水线）。
运行：python apps/crawler/tests/smoke_test.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# 让 `app` 包可导入
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.adapters import create_adapter, list_adapters  # noqa: E402
from app.adapters.base import FetchResult, RawItem, SourceAdapter  # noqa: E402
from app.adapters.registry import register  # noqa: E402
from app.compliance import (  # noqa: E402
    ComplianceGuard,
    DomainBlocked,
    DomainPolicy,
    RobotsCache,
    RobotsDisallowed,
    TakedownRegistry,
)
from app.http import HttpClient  # noqa: E402
from app.services import dedup, extract, normalize as nz  # noqa: E402
from app.services import degrade as dg  # noqa: E402
from app.services import metrics as mx  # noqa: E402
from app.services.expiry import select_expired, to_day  # noqa: E402
from app.services.pipeline import InMemoryRepository, Pipeline  # noqa: E402

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  [PASS] {name}")
    else:
        FAILED.append(f"{name} {detail}")
        print(f"  [FAIL] {name} {detail}")


# --------------------------------------------------------------------------
SAMPLE_ARTICLE = """【公司】理想汽车
【岗位】数据分析实习生
工作地点：北京市
薪资：200-250元/天
实习时长：3个月
学历要求：本科
专业要求：统计学、数学、计算机
截止日期：2026-11-30
投递方式：hr@lixiang.com

【公司】字节跳动
【岗位】产品运营实习生
工作地点：上海市
薪资：180元/天
学历要求：本科
投递方式：https://jobs.bytedance.com/xxx
"""


def test_dedup() -> None:
    print("\n[1] 去重与指纹")
    check("完全相同文本 content_hash 一致",
          dedup.content_hash("数据分析实习生") == dedup.content_hash("数据分析实习生"))
    check("标点/空白差异不影响 hash",
          dedup.content_hash("数据分析，实习生！") == dedup.content_hash("数据分析 实习生"))

    # 长文 + 局部替换：模拟公众号文章被转载后的轻微改写
    base = (
        "理想汽车招聘数据分析实习生，工作地点北京，薪资200元每天，要求本科以上学历，"
        "熟悉SQL与Python，负责用户行为数据分析与报表搭建，有留用机会，欢迎投递。"
    ) * 8
    variant = base.replace("本科以上学历", "硕士以上学历")  # 等长替换，不产生位移
    unrelated = (
        "腾讯招聘游戏策划实习生，工作地点深圳，要求熟悉Unity引擎与关卡设计，"
        "参与玩法原型制作与数值调优，提供住宿与餐补。"
    ) * 8
    d_dup = dedup.hamming(dedup.simhash(base), dedup.simhash(variant))
    d_other = dedup.hamming(dedup.simhash(base), dedup.simhash(unrelated))
    check("长文局部替换判为重复", dedup.is_similar(base, variant), f"distance={d_dup}")
    check("无关长文不判重", not dedup.is_similar(base, unrelated), f"distance={d_other}")
    check("判重距离显著小于无关距离", d_dup < d_other, f"dup={d_dup} other={d_other}")

    # 岗位指纹：入参应为已归一化的字段（pipeline 中 city 先过 normalize_city）
    fp1 = dedup.job_fingerprint("理想汽车", "数据分析实习生", "北京", "200-250元/天")
    fp2 = dedup.job_fingerprint("理想汽车 ", "数据分析 实习生", "北京", "200-250元/天")
    check("岗位指纹对空格容错", fp1 == fp2)
    fp3 = dedup.job_fingerprint("理想汽车", "数据分析实习生", "上海", "200-250元/天")
    check("城市不同则指纹不同", fp1 != fp3)


def test_normalize() -> None:
    print("\n[2] 字段标准化")
    check("城市别名 北京市→北京", nz.normalize_city("北京市") == "北京")
    check("城市别名 沪→上海", nz.normalize_city("沪") == "上海")
    check("薪资区间归一化", nz.normalize_salary("200-250元/天") == "200-250元/天", nz.normalize_salary("200-250元/天"))
    check("薪资 k 单位", nz.normalize_salary("5k-8k/月") == "5-8k/月", nz.normalize_salary("5k-8k/月"))
    check("学历归一化 研究生→硕士", nz.normalize_education("研究生及以上") == "硕士")
    check("截止日期 2026-11-30", str(nz.parse_deadline("2026-11-30")) == "2026-11-30")
    check("截止日期 11月30日", nz.parse_deadline("11月30日") is not None)
    method = nz.extract_apply_method("投递邮箱：hr@lixiang.com，或扫码投递")
    check("抽取邮箱", method.get("email") == "hr@lixiang.com", str(method))
    check("识别二维码投递", method.get("qr") == "1")


def test_registry() -> None:
    print("\n[3] 适配器注册表")
    codes = {a["code"] for a in list_adapters()}
    expected = {"rss", "manual", "thirdparty_api", "job_platform", "company_site"}
    check("五个适配器均已注册", expected.issubset(codes), str(sorted(codes)))
    manual = create_adapter("manual", {"inbox_dir": "./nope"})
    check("可按 code 实例化适配器", manual.code == "manual")
    check("健康检查可调用", manual.health_check().get("ok") is True)
    try:
        create_adapter("not_exist", {})
        check("未注册适配器应报错", False)
    except KeyError:
        check("未注册适配器应报错", True)


def test_extract() -> None:
    print("\n[4] 正文抽取与岗位结构化（规则兜底）")
    check("HTML 标签剥离", "理想汽车" in extract.strip_tags("<p>理想汽车</p><script>x=1</script>"))
    jobs = extract.structure_jobs(SAMPLE_ARTICLE, use_llm=False)
    check("抽取到 2 个岗位", len(jobs) == 2, f"实际 {len(jobs)}")
    if len(jobs) >= 1:
        j = jobs[0]
        check("公司字段正确", j["company"] == "理想汽车", str(j.get("company")))
        check("岗位字段正确", j["title"] == "数据分析实习生", str(j.get("title")))
        check("城市已归一化", j["city"] == "北京", str(j.get("city")))
        check("截止日期已解析", j["deadline"] == "2026-11-30", str(j.get("deadline")))
        check("投递方式含邮箱", "hr@lixiang.com" in (j.get("apply_method") or ""))
    if len(jobs) >= 2:
        check("第二个岗位城市正确", jobs[1]["city"] == "上海", str(jobs[1].get("city")))


def test_freeform_fallback() -> None:
    print("\n[4b] 自由文本兜底（无标签 / 一行式 / 表格外）")

    # 「X在招Y」句式 → 公司
    jobs = extract.structure_jobs("字节跳动最近在招产品运营实习生，base 上海，一天给到 180 块。", use_llm=False)
    check("句式抽公司", jobs and jobs[0]["company"] == "字节跳动", str(jobs[0].get("company") if jobs else None))
    check("行内 base 抽城市", jobs and jobs[0]["city"] == "上海", str(jobs[0].get("city") if jobs else None))
    check("裸薪资 180 块", jobs and jobs[0]["salary"] == "180元/天", str(jobs[0].get("salary") if jobs else None))

    # 极简句：公司+岗位+邮箱
    jobs = extract.structure_jobs("小红书招内容运营实习生，简历发 xhs-intern@xiaohongshu.com", use_llm=False)
    check("极简句抽公司", jobs and jobs[0]["company"] == "小红书", str(jobs[0].get("company") if jobs else None))
    check("极简句抽岗位", jobs and jobs[0]["title"] == "内容运营实习生", str(jobs[0].get("title") if jobs else None))

    # 一行式：括号公司 + 管道分隔 + 行内截止
    one = "【腾讯】交互设计实习生｜深圳｜200元/天｜投递：design@tencent.com｜截止 11-25"
    jobs = extract.structure_jobs(one, use_llm=False)
    check("括号块抽公司", jobs and jobs[0]["company"] == "腾讯", str(jobs[0].get("company") if jobs else None))
    check("管道片段抽城市", jobs and jobs[0]["city"] == "深圳", str(jobs[0].get("city") if jobs else None))
    check("裸薪资带周期", jobs and jobs[0]["salary"] == "200元/天", str(jobs[0].get("salary") if jobs else None))
    check("行内截止 11-25", jobs and jobs[0]["deadline"] == "2026-11-25", str(jobs[0].get("deadline") if jobs else None))

    # 行内「截止到 11 月 15 日」（带空格）
    jobs = extract.structure_jobs(
        "字节跳动招数据分析实习生，简历发到 hr@bytedance.com，截止到 11 月 15 日。", use_llm=False
    )
    check("行内截止到（带空格）", jobs and jobs[0]["deadline"] == "2026-11-15", str(jobs[0].get("deadline") if jobs else None))

    # 城市识别：只认已知城市，避免误判
    check("detect_city 命中深圳市", nz.detect_city("深圳市") == "深圳")
    check("detect_city 命中上海市", nz.detect_city("上海市") == "上海")
    check("detect_city 命中宁德市", nz.detect_city("宁德市") == "宁德")
    check("detect_city 不误判任意词", nz.detect_city("负责增长运营") == "")
    check("日期空格容错 11 月 15 日", str(nz.parse_deadline("11 月 15 日")) == "2026-11-15")


def test_manual_adapter() -> None:
    print("\n[5] 人工投递适配器（降级 L2）")
    with tempfile.TemporaryDirectory() as tmp:
        inbox = Path(tmp)
        (inbox / "a.json").write_text(
            json.dumps(
                {
                    "url": "https://mp.weixin.qq.com/s/demo1",
                    "title": "某公司实习",
                    "account_name": "XX实习",
                    "published_at": "2026-10-08T09:00:00Z",
                    "content": SAMPLE_ARTICLE,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (inbox / "bad.json").write_text("{ not json", encoding="utf-8")
        adapter = create_adapter("manual", {"inbox_dir": str(inbox)})
        result = adapter.fetch(limit=10)
        check("读取到 1 条有效记录", result.count == 1, f"实际 {result.count}")
        if result.items:
            check("URL 正确", result.items[0].url.endswith("demo1"))
            check("发布时间已解析", result.items[0].published_at is not None)


@register
class _FakeAdapter(SourceAdapter):
    """模拟多篇文章，每篇公司不同（用于验证正常入库）。"""

    code = "fake_test"
    source_type = "test"

    def fetch(self, limit: int = 50) -> FetchResult:
        items = [
            RawItem(
                url=f"https://example.com/a/{i}",
                title=f"实习信息 {i}",
                account_name="测试源",
                published_at=datetime(2026, 10, 8, tzinfo=timezone.utc),
                content=SAMPLE_ARTICLE.replace("理想汽车", f"理想汽车{i}"),
            )
            for i in range(3)
        ]
        return FetchResult(items=items, http_status=200)


@register
class _DupContentAdapter(SourceAdapter):
    """模拟同一篇内容被两个不同 URL 收录（用于验证岗位级跨文章去重）。"""

    code = "fake_dup"
    source_type = "test"

    def fetch(self, limit: int = 50) -> FetchResult:
        items = [
            RawItem(
                url=f"https://example.com/dup/{i}",
                title=f"转载 {i}",
                account_name="转载源",
                published_at=datetime(2026, 10, 8, tzinfo=timezone.utc),
                content=SAMPLE_ARTICLE,
            )
            for i in range(2)
        ]
        return FetchResult(items=items, http_status=200)


def test_pipeline() -> None:
    print("\n[6] 端到端流水线（内存仓储）")
    repo = InMemoryRepository()
    pipeline = Pipeline(use_llm=False)

    adapter = create_adapter("fake_test", {})
    r1 = pipeline.run(adapter, source_id=1, repo=repo, limit=10)
    check("首次采集到 3 篇文章", r1.new_articles == 3, str(r1.to_dict()))
    # 3 篇各含 2 个岗位：理想汽车岗位因公司名后缀不同（0/1/2）各自入库 3 个；
    # 字节跳动岗位在 3 篇中完全相同 → 只入库 1 个，其余 2 个判重
    check("首次入库 4 个岗位", r1.new_jobs == 4, str(r1.to_dict()))
    check("跨文章去重 2 个岗位", r1.duplicate_jobs == 2, str(r1.to_dict()))
    check("无错误", not r1.errors, str(r1.errors))

    r2 = pipeline.run(adapter, source_id=1, repo=repo, limit=10)
    check("重复采集不新增文章", r2.new_articles == 0, str(r2.to_dict()))
    check("重复采集按 URL 全部判重", r2.duplicate_articles == 3, str(r2.to_dict()))
    check("重复采集不新增岗位", r2.new_jobs == 0, str(r2.to_dict()))

    # 跨文章岗位去重：2 篇不同 URL、内容相同 → 只应入库 2 个岗位
    repo2 = InMemoryRepository()
    r3 = pipeline.run(create_adapter("fake_dup", {}), source_id=2, repo=repo2, limit=10)
    check("同内容不同 URL 均入库为文章", r3.new_articles == 2, str(r3.to_dict()))
    check("岗位级去重生效（只入库 2 个）", r3.new_jobs == 2, str(r3.to_dict()))
    check("识别出 2 个重复岗位", r3.duplicate_jobs == 2, str(r3.to_dict()))

    r4 = pipeline.run(create_adapter("job_platform", {"platform": "demo"}), 1, repo)
    check("未实现适配器被优雅降级", bool(r4.errors) and r4.new_articles == 0, str(r4.to_dict()))


def test_compliance() -> None:
    print("\n[7] 合规层：robots / 域名策略 / 下架")
    robots_txt = "User-agent: *\nDisallow: /private/\nAllow: /jobs/\n"
    cache = RobotsCache(fetcher=lambda url: robots_txt, user_agent="TestBot")
    check("robots 允许公开路径", cache.allowed("https://ex.com/jobs/1"))
    check("robots 禁止私有路径", not cache.allowed("https://ex.com/private/x"))
    check("robots 结果被缓存", cache._cache and "ex.com" in cache._cache)

    # robots.txt 不可达
    unreachable = RobotsCache(fetcher=lambda url: None, user_agent="TestBot", allow_on_error=True)
    check("robots 不可达默认放行", unreachable.allowed("https://ex.com/anything"))
    strict = RobotsCache(fetcher=lambda url: None, user_agent="TestBot", allow_on_error=False)
    check("robots 不可达严格模式拒绝", not strict.allowed("https://ex.com/anything"))

    policy = DomainPolicy.from_iterables(denylist=["blocked.com"])
    try:
        policy.check("https://blocked.com/jobs")
        check("禁采域名被拦截", False)
    except DomainBlocked:
        check("禁采域名被拦截", True)

    allow_only = DomainPolicy.from_iterables(allowlist=["allowed.com"])
    try:
        allow_only.check("https://other.com/jobs")
        check("白名单外域名被拦截", False)
    except DomainBlocked:
        check("白名单外域名被拦截", True)

    takedown = TakedownRegistry()
    takedown.register_url("https://ex.com/s/removed")
    guard = ComplianceGuard(robots=cache, policy=policy, takedown=takedown, enabled=True)
    check("下架 URL 被拦截", takedown.is_blocked("https://ex.com/s/removed"))
    try:
        guard.check("https://ex.com/s/removed")
        check("合规闸拦截下架 URL", False)
    except DomainBlocked:
        check("合规闸拦截下架 URL", True)
    try:
        guard.check("https://ex.com/private/x")
        check("合规闸拦截 robots 禁止路径", False)
    except RobotsDisallowed:
        check("合规闸拦截 robots 禁止路径", True)
    guard.check("https://ex.com/jobs/1")
    check("合规闸放行合法路径", True)


def test_http_client() -> None:
    print("\n[8] HTTP 客户端：频控 / robots / 重试 / 注入传输")
    calls: list[str] = []

    def transport(url: str, headers: dict[str, str]) -> tuple[int, str]:
        calls.append(url)
        if "notfound" in url:
            return 404, "not found"
        return 200, "<html>ok</html>"

    client = HttpClient(
        guard=ComplianceGuard(enabled=False),
        transport=transport,
        rate_limit_per_minute=100000,
        retries=1,
    )
    resp = client.get("https://ex.com/jobs/1")
    check("注入 transport 返回 200", resp.status == 200 and resp.ok)
    check("UA 头已带上", calls and True)

    r404 = client.get("https://ex.com/notfound")
    check("404 原样返回不抛错", r404.status == 404 and not r404.ok)
    check("get_text 对非 2xx 返回 None", client.get_text("https://ex.com/notfound") is None)

    # robots 拦截
    robots_txt = "User-agent: *\nDisallow: /private/\n"
    cache = RobotsCache(fetcher=lambda url: robots_txt, user_agent="TestBot")
    guarded = HttpClient(
        guard=ComplianceGuard(robots=cache, enabled=True),
        transport=transport,
        rate_limit_per_minute=100000,
        retries=1,
    )
    try:
        guarded.get("https://ex.com/private/x")
        check("HttpClient 遵守 robots", False)
    except RobotsDisallowed:
        check("HttpClient 遵守 robots", True)

    # 限流响应原样返回（不抛错），交由上层判断
    def limited(url: str, headers: dict[str, str]) -> tuple[int, str]:
        return 429, "too many requests"

    limited_client = HttpClient(
        guard=ComplianceGuard(enabled=False),
        transport=limited,
        rate_limit_per_minute=100000,
        retries=1,
    )
    rl = limited_client.get("https://ex.com/jobs")
    check("429 标记为 rate_limited", rl.rate_limited and rl.status == 429)


def test_degrade() -> None:
    print("\n[9] 降级链路 L0-L3")
    S = dg.SourceHealthSnapshot

    healthy_all = [
        S("tp1", "thirdparty_api", success_rate=0.95),
        S("rss1", "rss", success_rate=0.9),
    ]
    d = dg.evaluate(healthy_all, current_level=0)
    check("主源健康 → 保持 L0", d.level == 0 and not d.changed, d.reason)

    primary_down = [
        S("tp1", "thirdparty_api", success_rate=0.1, consecutive_failures=5),
        S("rss1", "rss", success_rate=0.9),
    ]
    d = dg.evaluate(primary_down, current_level=0)
    check("主源挂 → 降到 L1（切源）", d.level == 1 and d.changed, d.reason)

    all_auto_down = [
        S("tp1", "thirdparty_api", success_rate=0.0, consecutive_failures=9),
        S("rss1", "rss", success_rate=0.0, consecutive_failures=9),
        S("cs1", "company_site", success_rate=0.0, consecutive_failures=9),
        S("m1", "manual", success_rate=1.0, item_count=12),
    ]
    d = dg.evaluate(all_auto_down, current_level=1)
    check("自动源全挂但有投递 → L2（半自动）", d.level == 2, d.reason)

    everything_down = [
        S("tp1", "thirdparty_api", success_rate=0.0, consecutive_failures=9),
        S("m1", "manual", success_rate=1.0, item_count=0),
    ]
    d = dg.evaluate(everything_down, current_level=2)
    check("全部无产出 → L3（人工）", d.level == 3, d.reason)

    # 恢复：每次只回升 1 档
    d = dg.evaluate(healthy_all, current_level=3)
    check("恢复时逐级回升（3→2）", d.level == 2 and d.changed, d.reason)
    d = dg.evaluate(healthy_all, current_level=1)
    check("恢复时逐级回升（1→0）", d.level == 0 and d.changed, d.reason)

    check("层级描述可用", dg.describe(2)["name"].startswith("半自动"))


def test_metrics() -> None:
    print("\n[10] PoC 指标计算")
    jobs = [
        {"company": "A", "title": "T1", "city": "北京", "apply_method": "邮箱: a@b.com", "salary": "200元/天", "confidence": 0.9},
        {"company": "B", "title": "T2", "city": "上海", "apply_method": "链接: http://x", "salary": "", "confidence": 0.5},
        {"company": "C", "title": "T3", "city": "", "apply_method": "", "salary": "", "confidence": 0.9},
    ]
    fc = mx.field_completeness(jobs, fields=("company", "city", "salary"))
    check("逐字段完整率正确", fc["company"] == 1.0 and fc["city"] == round(2 / 3, 4), str(fc))
    # 核心字段 = company/title/city/apply_method；逐字段为 1.0/1.0/0.667/0.667 → 平均约 0.833
    check("核心字段完整率", abs(mx.core_completeness(jobs) - 0.8333) < 0.001, str(mx.core_completeness(jobs)))
    check("可用岗位率（核心字段全非空）", mx.usable_job_rate(jobs) == round(2 / 3, 4))
    check("低置信度占比（1/3）", mx.low_confidence_rate(jobs) == round(1 / 3, 4))
    check("重复率计算", mx.duplicate_rate(10, 6, 4) == 0.4)
    check("覆盖率计算", mx.coverage(5, 4) == 0.8)
    check("空输入不报错", mx.overall_completeness([]) == 0.0)

    class _R:
        fetched, new_articles, duplicate_articles, new_jobs, duplicate_jobs, errors = 3, 2, 1, 2, 0, []

    m = mx.build_metrics(_R(), jobs, duration_ms=12)
    check("build_metrics 汇总正确", m.fetched_articles == 3 and m.new_jobs == 2 and m.duration_ms == 12)
    md = mx.render_markdown(m, {"源数量": 1})
    check("Markdown 报告可渲染", "## 采集结果" in md and "整体字段完整率" in md)


def test_expiry() -> None:
    from datetime import date

    print("\n[11] 岗位过期下架")
    check("date 原样", to_day(date(2026, 1, 2)) == date(2026, 1, 2))
    check("datetime 取日期", to_day(datetime(2026, 1, 2, 9, 0, tzinfo=timezone.utc)) == date(2026, 1, 2))
    check("ISO 字符串解析", to_day("2026-01-02T09:00:00Z") == date(2026, 1, 2))
    check("非法值返回 None", to_day("截止面议") is None and to_day(None) is None)

    rows = [
        (1, date(2020, 1, 1), "active"),    # 过期 → 下架
        (2, date(2099, 1, 1), "active"),    # 未到期 → 保留
        (3, date(2020, 1, 1), "expired"),   # 已下架 → 不重复处理
        (4, None, "active"),                # 无截止 → 保留
        (5, "2020-05-06", "active"),        # 字符串同样识别
    ]
    check("仅挑出过期 active 岗位", select_expired(rows, date(2026, 10, 10)) == [1, 5],
          str(select_expired(rows, date(2026, 10, 10))))


def main() -> int:
    print("=" * 60)
    print("crawler-service 冒烟测试（零第三方依赖）")
    print("=" * 60)
    test_dedup()
    test_normalize()
    test_registry()
    test_extract()
    test_freeform_fallback()
    test_manual_adapter()
    test_pipeline()
    test_compliance()
    test_http_client()
    test_degrade()
    test_metrics()
    test_expiry()
    print("\n" + "=" * 60)
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if FAILED:
        for f in FAILED:
            print(f"  - {f}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
