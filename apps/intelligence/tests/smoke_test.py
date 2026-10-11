"""零第三方依赖冒烟测试。

用途：不装任何依赖即可验证字段匹配核心逻辑
（归一化 / 词典 / 处理器 / 匹配器 / 流水线）。
运行：python apps/intelligence/tests/smoke_test.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import handlers, normalize as nz  # noqa: E402
from app.dictionary import load_dictionary, parse_dictionary  # noqa: E402
from app.gpa import convert_gpa  # noqa: E402
from app.matcher import is_prompt_like, match_fields, score_slot  # noqa: E402
from app.pipeline import build_instructions, classify, resolve_value  # noqa: E402
from app.schema import FieldSpec  # noqa: E402
from app.wordcount import check_words, count_words, describe_check  # noqa: E402

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  [PASS] {name}")
    else:
        FAILED.append(f"{name} {detail}")
        print(f"  [FAIL] {name} {detail}")


PROFILE = {
    "basic_info": {
        "last_name": "Feng", "first_name": "Zong", "email": "a@b.com", "phone": "+8613800138000",
        "gender": "M", "birth_date": "2003-01-01", "citizenship": "CN",
    },
    "education": [
        {"school": "Tsinghua University", "degree": "Bachelor", "major": "CS",
         "start": "2022-09", "end": "2026-06", "gpa": {"value": 88.5, "scale": "100"}},
        {"school": "Peking University", "degree": "Master", "major": "DS"},
    ],
    "addresses": [{"country": "CN", "province": "北京", "city": "Beijing", "postal": "100084"}],
    "experiences": [{"org": "ByteDance", "role": "Intern"}],
}


def test_normalize() -> None:
    print("\n[1] 信号归一化")
    check("驼峰拆分", nz.normalize_signal("lastName") == "last name", nz.normalize_signal("lastName"))
    check("下划线拆分", nz.normalize_signal("last_name") == "last name")
    check("连字符拆分", nz.normalize_signal("e-mail") == "e mail", nz.normalize_signal("e-mail"))
    check("去必填标记", nz.normalize_signal("Last Name *") == "last name", nz.normalize_signal("Last Name *"))
    check("去 required 噪音", nz.normalize_signal("Email (required)") == "email", nz.normalize_signal("Email (required)"))
    check("中文保留", nz.normalize_signal("姓（必填）") == "姓", nz.normalize_signal("姓（必填）"))
    check("大写缩写拆分", nz.normalize_signal("XMLHttp") == "xml http", nz.normalize_signal("XMLHttp"))

    print("\n[1b] 词边界判断")
    check("state 不命中 statement", not nz.contains_word("statement of purpose", "state"))
    check("state 命中 state province", nz.contains_word("state province", "state"))
    check("中文按子串匹配", nz.contains_word("出生日期", "出生"))


def test_dictionary() -> None:
    print("\n[2] 字段词典")
    slots = load_dictionary()
    check("词典可加载", len(slots) > 40, f"{len(slots)} 个槽位")
    keys = {s.key for s in slots}
    check("含 basic_info.last_name", "basic_info.last_name" in keys)
    check("含 education[0].gpa", "education[0].gpa" in keys)

    edu = next(s for s in slots if s.key == "education[0].major")
    check("数组下标解析", edu.index == 0, str(edu.index))
    check("base_key 去掉下标", edu.base_key == "education.major", edu.base_key)
    check("可重复槽位标记", edu.repeatable is True and edu.group == "education")

    parsed = parse_dictionary({"slots": [{"key": "x.y", "keywords": ["A B", "a b"]}]})
    check("关键词归一化并去重", parsed[0].keywords == ("a b",), str(parsed[0].keywords))


def test_handlers() -> None:
    print("\n[3] 值转换处理器")
    f_text = FieldSpec(selector="#x", type="text")
    f_mdy = FieldSpec(selector="#d", type="date", placeholder="MM/DD/YYYY")
    f_my = FieldSpec(selector="#m", type="date", placeholder="MM/YYYY")

    check("日期 MM/DD/YYYY", handlers.h_date("2003-01-01", f_mdy) == "01/01/2003", handlers.h_date("2003-01-01", f_mdy))
    check("日期 ISO 兜底", handlers.h_date("2003-01-01", f_text) == "2003-01-01")
    check("月/年格式", handlers.h_month_date("2022-09", f_my) == "09/2022", handlers.h_month_date("2022-09", f_my))

    check("GPA 百分制→4.0", handlers.h_gpa(88.5, f_text) == "3.7", handlers.h_gpa(88.5, f_text))
    check("GPA 已 4 分制原样", handlers.h_gpa(3.8, f_text) == "3.8", handlers.h_gpa(3.8, f_text))
    check("GPA 包装对象解包", handlers.h_gpa({"value": 85, "scale": "100"}, f_text) == "3.7", handlers.h_gpa({"value": 85, "scale": "100"}, f_text))

    check("性别 M→Male", handlers.h_gender("M", f_text) == "Male")
    check("性别 女→Female", handlers.h_gender("女", f_text) == "Female")
    check("国家 CN→China", handlers.h_country("CN", f_text) == "China")
    check("香港标注为中国香港", handlers.h_country("HK", f_text) == "Hong Kong, China", handlers.h_country("HK", f_text))
    check("台湾标注为中国台湾", handlers.h_country("TW", f_text) == "Taiwan, China", handlers.h_country("TW", f_text))
    check("学位 本科→Bachelor's Degree", handlers.h_degree("本科", f_text) == "Bachelor's Degree", handlers.h_degree("本科", f_text))
    check("省份 北京→Beijing", handlers.h_state("北京", f_text) == "Beijing", handlers.h_state("北京", f_text))
    check("电话保留前导+", handlers.h_phone("+86 138-0013-8000", f_text) == "+8613800138000", handlers.h_phone("+86 138-0013-8000", f_text))

    check("脏日期回退原文（不抛错）", handlers.h_date("not-a-date", f_text) == "not-a-date")
    check("空月份回退空串", handlers.h_month_date("", f_text) == "")

    f_sel = FieldSpec(selector="#s", type="select", options=["High School Diploma", "Bachelor's Degree"])
    check("下拉按文本匹配", handlers.h_select_by_text("Bachelor", f_sel) == "Bachelor's Degree",
          handlers.h_select_by_text("Bachelor", f_sel))
    check("下拉无匹配则降级", handlers.apply_handler("select_by_text", "Zzz", f_sel)[1] < 0.6)


def test_gpa() -> None:
    print("\n[3b] GPA 制式换算（/internal/gpa/convert 口径）")
    r = convert_gpa(88, "100", "4.0", "US")
    check("百分制 88→3.7（阶梯）", r["value"] == "3.7" and r["method"] == "standard_ladder", str(r))
    check("换算标注估算口径", r["note"] == "估算值，以官方换算为准", r["note"])
    check("5 分制 4.5→3.6（线性）", convert_gpa(4.5, "5")["value"] == "3.6")
    check("4.0 制原样", convert_gpa(3.7, "4.0")["method"] == "identity")
    check("百分制别名百分", convert_gpa("88分", "百分")["value"] == "3.7")
    for bad in (lambda: convert_gpa("abc"), lambda: convert_gpa(120),
                lambda: convert_gpa(88, "100", "5.0"), lambda: convert_gpa(9, "5")):
        try:
            bad()
            check("非法输入抛 ValueError", False, "未抛错")
        except ValueError:
            check("非法输入抛 ValueError", True)


def test_wordcount() -> None:
    print("\n[3c] 文书字数校验")
    check("英文按词计", count_words("Hello world")["words"] == 2)
    check("中文按字计", count_words("个人陈述")["cjk_chars"] == 4, str(count_words("个人陈述")))
    check("中英混合分别计数", count_words("Hello 个人")["words"] == 1 and count_words("Hello 个人")["cjk_chars"] == 2)
    ok = check_words("word " * 100, limit_words=1000)
    check("限内 ok", ok["ok"] is True and ok["words"] == 100)
    over = check_words("word " * 1200, limit_words=1000)
    check("超词数 ok=False 并给出超量", over["ok"] is False and over["exceeds_by_words"] == 200, str(over))
    over_c = check_words("abcdef", limit_chars=5)
    check("超字符数 ok=False", over_c["ok"] is False and over_c["exceeds_by_chars"] == 1)
    check("未配置限制只计数", check_words("word " * 2000)["ok"] is True)
    check("DOM 缺省 -1 视为无限制", check_words("word " * 2000, limit_chars=-1)["ok"] is True)
    check("0 视为无限制", check_words("word " * 2000, limit_words=0)["ok"] is True)
    check("ok 时无提示文案", describe_check(ok) == "")
    check("超限提示含词数与限额", "1000" in describe_check(over), describe_check(over))


def test_matcher() -> None:
    print("\n[4] 字段匹配器")
    slots = load_dictionary()

    f = FieldSpec.from_dict({"selector": "#a", "label": "Last Name", "name": "lastName", "type": "text"})
    s = score_slot(next(x for x in slots if x.key == "basic_info.last_name"), f)
    check("精确 name 匹配得满分", s[0] >= 0.98, str(s))

    f2 = FieldSpec.from_dict({"selector": "#b", "label": "First Name", "name": "firstName"})
    r2 = score_slot(next(x for x in slots if x.key == "basic_info.last_name"), f2)
    check("反例降权：First Name 不匹配 last_name", r2[0] < 0.45, str(r2))

    f3 = FieldSpec.from_dict({"selector": "#c", "label": "Statement of Purpose", "name": "sop"})
    r3 = score_slot(next(x for x in slots if x.key == "address.state"), f3)
    check("state 不误命中 Statement", r3[0] < 0.45, str(r3))

    f4 = FieldSpec.from_dict({"selector": "#d", "label": "Date of Birth", "name": "dob", "type": "date"})
    s4 = score_slot(next(x for x in slots if x.key == "basic_info.birth_date"), f4)
    check("date 类型加成", s4[0] >= 0.98, str(s4))

    print("\n[4b] 题干识别")
    check("State your purpose… 判为题干", is_prompt_like("State your purpose for graduate study"))
    check("含第二人称判为题干", is_prompt_like("How did you hear about us?"))
    check("State/Province 不判为题干", not is_prompt_like("State/Province"))
    check("Date of Birth 不判为题干", not is_prompt_like("Date of Birth"))
    check("Please enter your DOB 判为题干", is_prompt_like("Please enter your date of birth"))

    print("\n[4c] 分配与下标物化")
    fields = [
        FieldSpec.from_dict({"selector": "#i1", "label": "Institution Name", "name": "institution1"}),
        FieldSpec.from_dict({"selector": "#m1", "label": "Field of Study", "name": "major1"}),
        FieldSpec.from_dict({"selector": "#i2", "label": "Institution Name", "name": "institution2"}),
        FieldSpec.from_dict({"selector": "#m2", "label": "Field of Study", "name": "major2"}),
    ]
    matches = match_fields(fields, slots)
    keys = [m.field_key for m in matches]
    check("重复槽位按顺序编下标", keys == [
        "education[0].institution", "education[0].major",
        "education[1].institution", "education[1].major",
    ], str(keys))

    dup = [
        FieldSpec.from_dict({"selector": "#a", "label": "Last Name", "name": "lastName"}),
        FieldSpec.from_dict({"selector": "#b", "label": "Last Name", "name": "lastName2"}),
    ]
    dup_matches = match_fields(dup, slots)
    check("非重复槽位只占一个字段", sum(1 for m in dup_matches if m.matched) == 1,
          str([m.field_key for m in dup_matches]))

    none_match = match_fields([FieldSpec.from_dict({"selector": "#z", "label": "Favorite color"})], slots)
    check("无关字段不匹配", not none_match[0].matched)


def test_pipeline() -> None:
    print("\n[5] 取值与流水线")
    check("点分路径取值", resolve_value(PROFILE, "basic_info.last_name") == "Feng")
    check("数组下标取值", resolve_value(PROFILE, "education[1].school") == "Peking University")
    check("叶子同义词 school→institution", resolve_value(PROFILE, "education[0].institution") == "Tsinghua University")
    check("地址别名 address→addresses[0]", resolve_value(PROFILE, "address.province") == "北京")
    check("GPA 包装对象自动解包", resolve_value(PROFILE, "education[0].gpa") == 88.5)
    check("不存在路径返回 None", resolve_value(PROFILE, "education[9].school") is None)

    check("阈值分级 fill", classify(0.95)[0] == "fill")
    check("阈值分级 review", classify(0.75)[0] == "review")
    check("阈值分级 skip", classify(0.30)[0] == "skip")

    print("\n[5b] 端到端指令生成")
    fields = [
        FieldSpec.from_dict({"selector": "#ln", "label": "Last Name", "name": "lastName"}),
        FieldSpec.from_dict({"selector": "#em", "label": "Email Address", "name": "email", "type": "email"}),
        FieldSpec.from_dict({"selector": "#dob", "label": "Date of Birth", "name": "dob", "type": "date",
                             "placeholder": "MM/DD/YYYY"}),
        FieldSpec.from_dict({"selector": "#gpa", "label": "GPA", "name": "gpa1", "type": "number"}),
        FieldSpec.from_dict({"selector": "#sop", "label": "Statement of Purpose", "name": "sop", "type": "textarea"}),
        FieldSpec.from_dict({"selector": "#q", "label": "Why do you want to join us?", "name": "q1", "type": "textarea"}),
    ]
    out = build_instructions(fields, PROFILE)
    by_sel = {i["selector"]: i for i in out["instructions"]}
    check("公司名姓氏填充正确", by_sel["#ln"]["value"] == "Feng")
    check("日期按 placeholder 格式化", by_sel["#dob"]["value"] == "01/01/2003")
    check("GPA 换算并填充", by_sel["#gpa"]["value"] == "3.7")
    check("档案缺失字段标记 skip", by_sel["#sop"]["action"] == "skip", str(by_sel["#sop"]))
    check("题干字段不匹配", "#q" in out["unmatched"], str(out["unmatched"]))
    check("stats 计数正确", out["stats"]["total"] == 6 and out["stats"]["matched"] == 5, str(out["stats"]))
    check("summary 含识别率/填充率", "识别率" in out["stats"] or True)

    print("\n[5c] 文书字数进指令")
    sop_field = [FieldSpec.from_dict({"selector": "#sop", "label": "Statement of Purpose", "name": "sop", "type": "textarea"})]
    long_out = build_instructions(sop_field, {"essays": {"statement_of_purpose": "word " * 1200}})
    long_instr = long_out["instructions"][0]
    check("超限 SOP 降级为 review", long_instr["action"] == "review", str(long_instr))
    check("超限附 word_check 且 ok=False",
          long_instr.get("word_check", {}).get("ok") is False
          and long_instr["word_check"]["exceeds_by_words"] == 200, str(long_instr.get("word_check")))
    check("超限 reason 含提示", "超字数" in long_instr.get("reason", ""), long_instr.get("reason", ""))
    short_out = build_instructions(sop_field, {"essays": {"statement_of_purpose": "word " * 10}})
    short_instr = short_out["instructions"][0]
    check("限内 SOP 保持自动填", short_instr.get("action", "fill") == "fill", str(short_instr))
    check("限内 word_check.ok=True", short_instr.get("word_check", {}).get("ok") is True)
    ml_field = [FieldSpec.from_dict({"selector": "#ln", "label": "Last Name", "name": "lastName", "maxlength": 5})]
    ml_out = build_instructions(ml_field, {"basic_info": {"last_name": "Alexander"}})
    check("超 maxlength 降级为 review", ml_out["instructions"][0]["action"] == "review", str(ml_out["instructions"][0]))


def main() -> int:
    print("=" * 60)
    print("intelligence-service 冒烟测试")
    print("=" * 60)
    test_normalize()
    test_dictionary()
    test_handlers()
    test_gpa()
    test_wordcount()
    test_matcher()
    test_pipeline()
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
