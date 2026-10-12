/**
 * 充电站孪生 · 3D 场景（IO 层）。
 *
 * 纯布局来自 ./layout.ts（可单测），这里只负责 three.js 的搭建 / 渲染 / 销毁。
 * 所有 DOM / WebGL 访问都在 useEffect 内，SSR（renderToString）只输出占位 div。
 *
 * 写实手段（零外部资产，全程序化）：
 * RoomEnvironment IBL 环境反射 + 渐变天空穹顶 + 程序化 PBR 纹理
 * + 挤出成型车身 + 接触阴影 + 夜景灯光锥。
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { StationLayout } from './layout';

interface Props {
  layout: StationLayout;
  night: boolean;
  solarRoof: boolean;
  roam: boolean;
  xray: boolean;
  selectedPile: string | null;
  onSelectPile: (id: string | null) => void;
  onCarClick: () => void;
}

const CYAN = 0x38bdf8;

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 径向渐变（接触阴影 / 灯光池共用）。 */
function radialTexture(inner: string, outer: string): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  });
}

function spotTexture(code: string): THREE.CanvasTexture {
  return canvasTexture(256, 512, (ctx) => {
    ctx.fillStyle = '#343b45';
    ctx.fillRect(0, 0, 256, 512);
    for (let i = 0; i < 900; i += 1) {
      const g = 52 + Math.floor(Math.random() * 36);
      ctx.fillStyle = `rgb(${g},${g + 4},${g + 9})`;
      ctx.fillRect(Math.random() * 256, Math.random() * 512, 2, 2);
    }
    // 轮胎压痕（两侧 faint 暗带）
    ctx.fillStyle = 'rgba(18,22,27,0.35)';
    for (const x of [52, 168]) {
      ctx.beginPath();
      ctx.roundRect(x, 30, 36, 452, 18);
      ctx.fill();
    }
    ctx.strokeStyle = '#eef3f8';
    ctx.lineWidth = 10;
    ctx.strokeRect(8, 8, 240, 496);
    ctx.fillStyle = 'rgba(238,243,248,0.95)';
    ctx.font = 'bold 62px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(code, 128, 452);
    ctx.fillStyle = 'rgba(56,189,248,0.95)';
    ctx.font = 'bold 38px sans-serif';
    ctx.fillText('⚡', 128, 82);
  });
}

function asphaltTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = '#3d434c';
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 5200; i += 1) {
      const g = 48 + Math.floor(Math.random() * 44);
      ctx.fillStyle = `rgb(${g},${g + 3},${g + 7})`;
      const s = Math.random() < 0.12 ? 3 : 2;
      ctx.fillRect(Math.random() * 512, Math.random() * 512, s, s);
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(18, 18);
  return tex;
}

function paverTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#a7adb5';
    ctx.fillRect(0, 0, 256, 256);
    for (let ty = 0; ty < 4; ty += 1) {
      for (let tx = 0; tx < 4; tx += 1) {
        const v = 158 + Math.floor(Math.random() * 22);
        ctx.fillStyle = `rgb(${v},${v + 3},${v + 7})`;
        ctx.fillRect(tx * 64 + 2, ty * 64 + 2, 60, 60);
      }
    }
    ctx.strokeStyle = '#8b9199';
    ctx.lineWidth = 3;
    for (let i = 0; i <= 4; i += 1) {
      ctx.beginPath(); ctx.moveTo(i * 64, 0); ctx.lineTo(i * 64, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * 64); ctx.lineTo(256, i * 64); ctx.stroke();
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function grassTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#5d9c52';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 260; i += 1) {
      const dark = Math.random() < 0.5;
      ctx.fillStyle = dark ? 'rgba(46,110,44,0.5)' : 'rgba(140,190,110,0.45)';
      const r = 3 + Math.random() * 9;
      ctx.beginPath();
      ctx.arc(Math.random() * 256, Math.random() * 256, r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 1);
  return tex;
}

/** 黄黑相间挡车器条纹。 */
function stopStripeTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(256, 48, (ctx) => {
    ctx.fillStyle = '#e8b93c';
    ctx.fillRect(0, 0, 256, 48);
    ctx.fillStyle = '#1c2026';
    for (let x = 0; x < 256; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 48); ctx.lineTo(x + 32, 0); ctx.lineTo(x + 64, 0); ctx.lineTo(x + 32, 48);
      ctx.fill();
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** 膜材 standing-seam 条纹。 */
function membraneTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = '#eef1f4';
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = '#d3d9e0';
    ctx.lineWidth = 3;
    for (let x = 0; x <= 512; x += 42) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 512); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let x = 6; x <= 512; x += 42) ctx.fillRect(x, 0, 8, 512);
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 3);
  return tex;
}

/** 集装箱波纹 +  stencil 字。 */
function containerTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 256, (ctx) => {
    ctx.fillStyle = '#98a1ab';
    ctx.fillRect(0, 0, 512, 256);
    for (let x = 0; x < 512; x += 24) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillRect(x, 0, 5, 256);
      ctx.fillStyle = 'rgba(40,48,56,0.3)';
      ctx.fillRect(x + 12, 0, 6, 256);
    }
    ctx.fillStyle = 'rgba(30,42,54,0.85)';
    ctx.font = 'bold 72px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('STORAGE', 256, 150);
  });
}

/** 玻璃幕墙（白天）/ 灯光窗（夜晚）成对纹理。 */
function facadeTextures(): { day: THREE.CanvasTexture; night: THREE.CanvasTexture } {
  const lit: string[][] = [];
  for (let y = 0; y < 10; y += 1) {
    lit.push([]);
    for (let x = 0; x < 12; x += 1) {
      const r = (x * 37 + y * 91) % 100;
      lit[y].push(r < 34 ? 'warm' : r < 42 ? 'cool' : 'off');
    }
  }
  const day = canvasTexture(512, 448, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 448);
    g.addColorStop(0, '#8fb4cb');
    g.addColorStop(1, '#54708a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 448);
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 12; x += 1) {
        const v = 150 + ((x * 37 + y * 91) % 60);
        ctx.fillStyle = `rgba(${v},${v + 12},${v + 22},0.85)`;
        ctx.fillRect(8 + x * 42, 10 + y * 43, 32, 28);
      }
    }
    ctx.fillStyle = '#39434e';
    for (let x = 0; x <= 12; x += 1) ctx.fillRect(x * 42 + 2, 0, 4, 448);
    for (let y = 0; y <= 10; y += 1) ctx.fillRect(0, y * 43 + 4, 512, 5);
  });
  const night = canvasTexture(512, 448, (ctx) => {
    ctx.fillStyle = '#0c131b';
    ctx.fillRect(0, 0, 512, 448);
      for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 12; x += 1) {
        const s = lit[y][x];
        ctx.fillStyle = s === 'warm' ? '#ffcf7d' : s === 'cool' ? '#bfe3ff' : '#141d27';
        ctx.fillRect(8 + x * 42, 10 + y * 43, 32, 28);
      }
    }
  });
  return { day, night };
}

function skyTexture(night: boolean): THREE.CanvasTexture {
  return canvasTexture(64, 512, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    if (night) {
      g.addColorStop(0, '#02040a');
      g.addColorStop(0.62, '#0a1426');
      g.addColorStop(0.8, '#16263f');
      g.addColorStop(1, '#0b1220');
    } else {
      g.addColorStop(0, '#2f6fd0');
      g.addColorStop(0.55, '#7fb2e8');
      g.addColorStop(0.78, '#cfe5f7');
      g.addColorStop(1, '#e8f0f6');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 512);
    if (night) {
      for (let i = 0; i < 130; i += 1) {
        ctx.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.6})`;
        ctx.fillRect(Math.random() * 64, Math.random() * 300, 1.4, 1.4);
      }
    } else {
      // 日晕
      const sun = ctx.createRadialGradient(32, 120, 4, 32, 120, 60);
      sun.addColorStop(0, 'rgba(255,250,230,0.95)');
      sun.addColorStop(1, 'rgba(255,250,230,0)');
      ctx.fillStyle = sun;
      ctx.fillRect(0, 40, 64, 160);
    }
  });
}

function labelSprite(text: string, sub: string): THREE.Sprite {
  const tex = canvasTexture(512, 192, (ctx) => {
    ctx.clearRect(0, 0, 512, 192);
    ctx.fillStyle = 'rgba(8,20,38,0.78)';
    ctx.beginPath();
    ctx.roundRect(56, 24, 400, 144, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(125,211,252,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(56, 24, 400, 144, 28);
    ctx.stroke();
    ctx.fillStyle = '#e8f4ff';
    ctx.font = 'bold 56px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, 256, 100);
    ctx.fillStyle = '#7dd3fc';
    ctx.font = '28px sans-serif';
    ctx.fillText(sub, 256, 142);
  });
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(6.4, 2.4, 1);
  return sp;
}

function solarTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 256, (ctx) => {
    ctx.fillStyle = '#12294d';
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = '#3d5a86';
    ctx.lineWidth = 3;
    for (let x = 0; x <= 512; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 256);
      ctx.stroke();
    }
    for (let y = 0; y <= 256; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(512, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(125,211,252,0.25)';
    ctx.fillRect(0, 0, 512, 40);
  });
}

interface CarRefs {
  group: THREE.Group;
  bodyMats: THREE.MeshPhysicalMaterial[];
  battery: THREE.Group;
}

/**
 * 程序化跑车：侧围挤出车身（X=车长，Y=高度，Z=车宽）+ 独立玻璃座舱
 * + 五辐轮毂 + 前后灯 + 尾翼 + 接触阴影。
 */
function buildCar(colorHex: string, aoTex: THREE.Texture): CarRefs {
  const group = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(colorHex),
    metalness: 0.85,
    roughness: 0.28,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.25,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x101c28,
    metalness: 0.9,
    roughness: 0.05,
    clearcoat: 1,
    envMapIntensity: 1.5,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.6, metalness: 0.3 });

  // —— 车身侧围挤出（含圆角倒角）
  const s = new THREE.Shape();
  s.moveTo(-2.2, 0.3);
  s.lineTo(-2.26, 0.68);
  s.quadraticCurveTo(-2.26, 0.78, -2.1, 0.79);
  s.lineTo(-1.0, 0.8);
  s.lineTo(1.0, 0.78);
  s.quadraticCurveTo(1.7, 0.74, 2.05, 0.6);
  s.quadraticCurveTo(2.28, 0.52, 2.28, 0.4);
  s.lineTo(2.28, 0.3);
  s.quadraticCurveTo(1.0, 0.22, -1.0, 0.24);
  s.quadraticCurveTo(-2.0, 0.25, -2.2, 0.3);
  const bodyGeo = new THREE.ExtrudeGeometry(s, {
    depth: 1.8,
    bevelEnabled: true,
    bevelThickness: 0.1,
    bevelSize: 0.09,
    bevelSegments: 3,
    steps: 1,
    curveSegments: 14,
  });
  bodyGeo.translate(0, 0, -0.9);
  const body = new THREE.Mesh(bodyGeo, paint);
  body.castShadow = true;
  group.add(body);

  // —— 玻璃座舱
  const gs = new THREE.Shape();
  gs.moveTo(-1.2, 0.74);
  gs.quadraticCurveTo(-1.05, 1.05, -0.72, 1.16);
  gs.lineTo(0.3, 1.2);
  gs.quadraticCurveTo(0.75, 1.18, 1.08, 0.76);
  gs.lineTo(1.02, 0.72);
  gs.lineTo(-1.14, 0.7);
  const glassGeo = new THREE.ExtrudeGeometry(gs, {
    depth: 1.58,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 2,
    curveSegments: 12,
  });
  glassGeo.translate(0, 0, -0.79);
  const cabin = new THREE.Mesh(glassGeo, glass);
  cabin.castShadow = true;
  group.add(cabin);

  // —— 前格栅 / 前唇 / 侧裙 / 尾部扩散器
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 1.3), trimMat);
  grille.position.set(2.3, 0.42, 0);
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.07, 1.9), trimMat);
  splitter.position.set(2.12, 0.24, 0);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 1.5), trimMat);
  diffuser.position.set(-2.28, 0.36, 0);
  for (const sz of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.12, 0.07), trimMat);
    skirt.position.set(0, 0.26, sz * 1.0);
    group.add(skirt);
  }
  group.add(grille, splitter, diffuser);

  // —— 尾翼
  const wingMat = paint;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 1.66), wingMat);
  blade.position.set(-2.08, 1.02, 0);
  blade.castShadow = true;
  group.add(blade);
  for (const sz of [-0.58, 0.58]) {
    const support = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.07), trimMat);
    support.position.set(-2.08, 0.88, sz);
    group.add(support);
  }

  // —— 后视镜
  for (const sz of [-1, 1]) {
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.22), trimMat);
    stalk.position.set(0.82, 0.92, sz * 1.02);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.2), paint);
    housing.position.set(0.82, 0.96, sz * 1.14);
    group.add(stalk, housing);
  }

  // —— 前后灯（夜晚增强）
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xdff3ff,
    emissive: 0xcdeaff,
    emissiveIntensity: 0.5,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x7a1010,
    emissive: 0xff2a2a,
    emissiveIntensity: 0.6,
  });
  for (const sz of [-0.55, 0.55]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.46), headMat);
    head.position.set(2.28, 0.62, sz);
    head.rotation.y = sz * -0.18;
    group.add(head);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 1.58), tailMat);
  tail.position.set(-2.29, 0.7, 0);
  group.add(tail);
  group.userData.headMat = headMat;
  group.userData.tailMat = tailMat;

  // —— 轮拱阴影 + 车轮（五辐）
  const wellMat = new THREE.MeshBasicMaterial({ color: 0x0a0d11 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.92 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xb9c2cb, metalness: 0.95, roughness: 0.25, envMapIntensity: 1.2 });
  const tireGeo = new THREE.CylinderGeometry(0.37, 0.37, 0.28, 26);
  const rimGeo = new THREE.CylinderGeometry(0.21, 0.21, 0.29, 18);
  const spokeGeo = new THREE.BoxGeometry(0.075, 0.36, 0.3);
  const wellGeo = new THREE.CircleGeometry(0.47, 22);
  for (const [wx, wz] of [[-1.45, -0.86], [-1.45, 0.86], [1.45, -0.86], [1.45, 0.86]] as const) {
    for (const side of [-1, 1]) {
      const well = new THREE.Mesh(wellGeo, wellMat);
      well.position.set(wx, 0.42, wz + side * 0.1);
      if (side < 0) well.rotation.y = Math.PI;
      group.add(well);
    }
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.rotation.x = Math.PI / 2;
    tire.position.set(wx, 0.37, wz);
    tire.castShadow = true;
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(wx, 0.37, wz);
    group.add(tire, rim);
    for (let k = 0; k < 5; k += 1) {
      const spoke = new THREE.Mesh(spokeGeo, rimMat);
      spoke.position.set(wx, 0.37, wz);
      spoke.rotation.z = (k / 5) * Math.PI * 2;
      group.add(spoke);
    }
  }

  // —— 接触阴影
  const ao = new THREE.Mesh(
    new THREE.PlaneGeometry(5.4, 3.0),
    new THREE.MeshBasicMaterial({ map: aoTex, transparent: true, depthWrite: false, opacity: 0.85 }),
  );
  ao.rotation.x = -Math.PI / 2;
  ao.position.y = 0.02;
  group.add(ao);

  // —— X 光电池（默认隐藏）
  const battery = new THREE.Group();
  const pack = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.2, 1.4),
    new THREE.MeshStandardMaterial({ color: 0x0b1a26, emissive: CYAN, emissiveIntensity: 0.5 }),
  );
  pack.position.y = 0.44;
  battery.add(pack);
  const cellMat = new THREE.MeshStandardMaterial({ color: 0x06283a, emissive: CYAN, emissiveIntensity: 1.1 });
  for (let i = 0; i < 6; i += 1) {
    const cell = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 1.2), cellMat);
    cell.position.set(-1.05 + i * 0.42, 0.57, 0);
    battery.add(cell);
  }
  battery.visible = false;
  group.add(battery);

  return { group, bodyMats: [paint], battery };
}

export function ChargeScene(props: Props) {
  const { layout } = props;
  const mountRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const P = () => propsRef.current;

    // ---------------------------------------------------------- 基础
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa8c6e8);
    scene.fog = new THREE.Fog(0xd8e6f3, 70, 170);

    // IBL 环境反射：零资产获得金属 / 车漆 / 玻璃的真实高光
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = 0.85;

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 600);
    camera.position.set(19, 15, 23);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.5, -1.5);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = (Math.PI / 2) * 0.94;
    controls.minDistance = 6;
    controls.maxDistance = 90;

    const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3d434c, 0.55);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1da, 2.4);
    sun.position.set(24, 30, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);

    const disposables: { dispose: () => void }[] = [];
    const track = <T extends { dispose: () => void }>(o: T): T => {
      disposables.push(o);
      return o;
    };

    // ---------------------------------------------------------- 天空穹顶
    const skyDayTex = track(skyTexture(false));
    const skyNightTex = track(skyTexture(true));
    const skyMat = new THREE.MeshBasicMaterial({ map: skyDayTex, side: THREE.BackSide, fog: false, depthWrite: false });
    const sky = new THREE.Mesh(track(new THREE.SphereGeometry(280, 24, 16)), skyMat);
    scene.add(sky);

    // ---------------------------------------------------------- 地面
    const aoTex = track(radialTexture('rgba(8,10,14,0.62)', 'rgba(8,10,14,0)'));
    const poolTex = track(radialTexture('rgba(255,225,160,0.5)', 'rgba(255,225,160,0)'));

    const ground = new THREE.Mesh(
      track(new THREE.PlaneGeometry(220, 220)),
      new THREE.MeshStandardMaterial({ map: track(asphaltTexture()), roughness: 0.94 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    scene.add(ground);

    const paverTex = track(paverTexture());
    const plazaW = layout.canopy.width + 14;
    const plazaD = layout.canopy.depth + 12;
    paverTex.repeat.set(plazaW / 4, plazaD / 4);
    const plaza = new THREE.Mesh(
      track(new THREE.PlaneGeometry(plazaW, plazaD)),
      new THREE.MeshStandardMaterial({ map: paverTex, roughness: 0.85 }),
    );
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 0.0;
    plaza.receiveShadow = true;
    scene.add(plaza);

    // 路缘石
    const curbMat = new THREE.MeshStandardMaterial({ color: 0x7d838b, roughness: 0.9 });
    const curbGeoX = track(new THREE.BoxGeometry(plazaW, 0.16, 0.3));
    const curbGeoZ = track(new THREE.BoxGeometry(0.3, 0.16, plazaD));
    for (const sz of [-1, 1]) {
      const cx = new THREE.Mesh(curbGeoX, curbMat);
      cx.position.set(0, 0.08, (sz * plazaD) / 2);
      cx.receiveShadow = true;
      const cz = new THREE.Mesh(curbGeoZ, curbMat);
      cz.position.set((sz * plazaW) / 2, 0.08, 0);
      cz.receiveShadow = true;
      scene.add(cx, cz);
    }

    // 草带
    const grassMat = new THREE.MeshStandardMaterial({ map: track(grassTexture()), roughness: 1 });
    for (const gz of [plazaD / 2 + 2.1, -plazaD / 2 - 2.1]) {
      const grass = new THREE.Mesh(track(new THREE.PlaneGeometry(plazaW, 3.6)), grassMat);
      grass.rotation.x = -Math.PI / 2;
      grass.position.set(0, 0.01, gz);
      grass.receiveShadow = true;
      scene.add(grass);
    }
    // 绿篱
    const hedgeMat = new THREE.MeshStandardMaterial({ color: 0x2f6b33, roughness: 1 });
    const hedgeGeo = track(new THREE.BoxGeometry(2.4, 0.75, 0.75));
    for (let hx = -plazaW / 2 + 2; hx < plazaW / 2 - 1; hx += 3.1) {
      if (Math.abs(hx) < 4) continue;
      const hedge = new THREE.Mesh(hedgeGeo, hedgeMat);
      hedge.position.set(hx, 0.38, plazaD / 2 + 1.1);
      hedge.castShadow = true;
      scene.add(hedge);
    }

    // ---------------------------------------------------------- 车位 / 桩
    const pileEdgeMats: THREE.MeshStandardMaterial[] = [];
    const pileLampMats: THREE.MeshStandardMaterial[] = [];
    const pileHit: THREE.Object3D[] = [];
    const carHit: THREE.Object3D[] = [];
    const carRefs: CarRefs[] = [];
    const carLampMats: { head: THREE.MeshStandardMaterial; tail: THREE.MeshStandardMaterial }[] = [];

    const stopGeo = track(new THREE.BoxGeometry(0.95, 0.15, 0.17));
    const stopMat = new THREE.MeshStandardMaterial({ map: track(stopStripeTexture()), roughness: 0.7 });
    const padGeo = track(new RoundedBoxGeometry(1.25, 0.09, 1.25, 2, 0.03));
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x232a33,
      roughness: 0.5,
      emissive: CYAN,
      emissiveIntensity: 0.14,
    });

    for (const spot of layout.spots) {
      const tex = track(spotTexture(spot.code));
      const m = new THREE.Mesh(
        track(new THREE.PlaneGeometry(spot.w, spot.d)),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(spot.x, 0.035, spot.z);
      m.receiveShadow = true;
      scene.add(m);

      for (const dz of [-1.7, 1.7]) {
        const stop = new THREE.Mesh(stopGeo, stopMat);
        stop.position.set(spot.x, 0.1, spot.z + dz);
        stop.castShadow = true;
        scene.add(stop);
      }
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(spot.x, 0.07, spot.z);
      pad.receiveShadow = true;
      scene.add(pad);

      if (spot.occupied && spot.carColor) {
        const car = buildCar(spot.carColor, aoTex);
        car.group.position.set(spot.x, 0.03, spot.z + 0.2);
        car.group.rotation.y = Math.PI / 2; // 车头朝桩（-Z）
        car.group.userData.isCar = true;
        scene.add(car.group);
        carRefs.push(car);
        carHit.push(car.group);
        carLampMats.push({
          head: car.group.userData.headMat as THREE.MeshStandardMaterial,
          tail: car.group.userData.tailMat as THREE.MeshStandardMaterial,
        });
      }
    }

    // ---------------------------------------------------------- 充电桩（圆角机身 + 状态灯 + 枪线）
    const pileBodyMat = new THREE.MeshStandardMaterial({
      color: 0xe8edf2,
      roughness: 0.32,
      metalness: 0.15,
      envMapIntensity: 0.9,
    });
    const pileBaseMat = new THREE.MeshStandardMaterial({ color: 0xb9bfc7, roughness: 0.7 });
    const screenTex = track(
      canvasTexture(128, 160, (ctx) => {
        ctx.fillStyle = '#0a1826';
        ctx.fillRect(0, 0, 128, 160);
        ctx.fillStyle = '#38bdf8';
        for (let i = 0; i < 3; i += 1) ctx.fillRect(14, 20 + i * 26, 100, 14);
        ctx.fillStyle = '#e8f4ff';
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('120kW', 64, 132);
      }),
    );
    const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const hitGeo = track(new THREE.BoxGeometry(2.4, 2.6, 2.4));
    const pileBodyGeo = track(new RoundedBoxGeometry(1.05, 1.78, 0.7, 4, 0.14));
    const pileBaseGeo = track(new RoundedBoxGeometry(1.24, 0.2, 0.94, 2, 0.05));
    const edgeGeo = track(new RoundedBoxGeometry(0.09, 1.7, 0.72, 2, 0.04));
    const lampGeo = track(new THREE.CylinderGeometry(0.09, 0.11, 0.1, 14));

    const statusColor = (st: string) => (st === 'charging' ? CYAN : st === 'fault' ? 0xff3b30 : 0x34d17b);

    for (const pile of layout.piles) {
      const g = new THREE.Group();
      g.position.set(pile.x, 0, pile.z);

      const base = new THREE.Mesh(pileBaseGeo, pileBaseMat);
      base.position.y = 0.1;
      const bodyM = new THREE.Mesh(pileBodyGeo, pileBodyMat);
      bodyM.position.y = 1.08;
      bodyM.castShadow = true;
      // 深色前面板 + 发光屏
      const panel = new THREE.Mesh(
        track(new RoundedBoxGeometry(0.72, 0.95, 0.06, 2, 0.03)),
        new THREE.MeshStandardMaterial({ color: 0x0c141d, roughness: 0.25, metalness: 0.5, envMapIntensity: 1.1 }),
      );
      panel.position.set(0, 1.32, 0.34);
      const screen = new THREE.Mesh(
        track(new THREE.PlaneGeometry(0.56, 0.7)),
        new THREE.MeshStandardMaterial({
          map: screenTex,
          emissive: 0x9fdcff,
          emissiveIntensity: 0.5,
          emissiveMap: screenTex,
          color: 0x111111,
        }),
      );
      screen.position.set(0, 1.32, 0.375);
      g.add(base, bodyM, panel, screen);

      // 顶部状态灯
      const lampMat = new THREE.MeshStandardMaterial({
        color: 0x0e2a3d,
        emissive: statusColor(pile.status),
        emissiveIntensity: pile.status === 'charging' ? 2.0 : 1.0,
      });
      pileLampMats.push(lampMat);
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(0, 2.02, 0);
      g.add(lamp);

      // 蓝色发光包边
      const edgeMat = new THREE.MeshStandardMaterial({
        color: 0x0e2a3d,
        emissive: CYAN,
        emissiveIntensity: pile.status === 'charging' ? 1.6 : 0.35,
      });
      pileEdgeMats.push(edgeMat);
      for (const ex of [-0.55, 0.55]) {
        const edge = new THREE.Mesh(edgeGeo, edgeMat);
        edge.position.set(ex, 1.06, 0);
        g.add(edge);
      }
      // 枪线：侧挂 → 垂落 → 地面
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.55, 1.15, 0.1),
        new THREE.Vector3(0.72, 0.7, 0.5),
        new THREE.Vector3(0.6, 0.25, 1.0),
        new THREE.Vector3(0.25, 0.06, 1.55),
      ]);
      const cable = new THREE.Mesh(
        track(new THREE.TubeGeometry(curve, 24, 0.05, 8)),
        new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.75 }),
      );
      cable.castShadow = true;
      const gun = new THREE.Mesh(track(new RoundedBoxGeometry(0.14, 0.14, 0.42, 2, 0.05)), trimLike());
      gun.position.set(0.25, 0.1, 1.55);
      gun.rotation.x = 0.5;
      g.add(cable, gun);

      // 桩下接触阴影
      const pileAo = new THREE.Mesh(
        track(new THREE.PlaneGeometry(2.6, 2.6)),
        new THREE.MeshBasicMaterial({ map: aoTex, transparent: true, depthWrite: false, opacity: 0.7 }),
      );
      pileAo.rotation.x = -Math.PI / 2;
      pileAo.position.y = 0.045;
      g.add(pileAo);

      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.y = 1.2;
      hit.userData.pileId = pile.id;
      g.add(hit);
      pileHit.push(hit);

      scene.add(g);
    }
    function trimLike(): THREE.Material {
      return new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.6, metalness: 0.3 });
    }

    // 选中光环
    const ring = new THREE.Mesh(
      track(new THREE.RingGeometry(1.0, 1.3, 40)),
      new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    ring.visible = false;
    scene.add(ring);

    // ---------------------------------------------------------- 雨棚（膜 + 檩条 + 悬臂柱）
    const canopyG = new THREE.Group();
    const colGeo = track(new THREE.CylinderGeometry(0.26, 0.32, layout.canopy.height, 16));
    const colMat = new THREE.MeshStandardMaterial({ color: 0xaab2bc, metalness: 0.75, roughness: 0.32, envMapIntensity: 1.0 });
    const plateGeo = track(new THREE.CylinderGeometry(0.52, 0.52, 0.09, 16));
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x4a5058, metalness: 0.6, roughness: 0.5 });
    const armGeo = track(new THREE.BoxGeometry(3.4, 0.24, 0.3));
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x7c8590, metalness: 0.6, roughness: 0.4 });
    for (const cx of layout.canopy.colX) {
      for (const cz of layout.canopy.colZ) {
        const col = new THREE.Mesh(colGeo, colMat);
        col.position.set(cx, layout.canopy.height / 2, cz);
        col.castShadow = true;
        const plate = new THREE.Mesh(plateGeo, plateMat);
        plate.position.set(cx, 0.045, cz);
        const arm = new THREE.Mesh(armGeo, beamMat);
        arm.position.set(cx, layout.canopy.height - 0.1, cz);
        arm.castShadow = true;
        canopyG.add(col, plate, arm);
      }
    }
    // 主梁 + 檩条
    for (const cz of layout.canopy.colZ) {
      const beam = new THREE.Mesh(track(new THREE.BoxGeometry(layout.canopy.width, 0.32, 0.32)), beamMat);
      beam.position.set(0, layout.canopy.height, cz);
      beam.castShadow = true;
      canopyG.add(beam);
    }
    const purlinGeo = track(new THREE.BoxGeometry(layout.canopy.width - 0.6, 0.1, 0.12));
    for (let pz = -layout.canopy.depth / 2 + 1.2; pz < layout.canopy.depth / 2; pz += 1.9) {
      const purlin = new THREE.Mesh(purlinGeo, beamMat);
      purlin.position.set(0, layout.canopy.height + 0.22, pz);
      canopyG.add(purlin);
    }
    const membraneTex = track(membraneTexture());
    const membraneMat = new THREE.MeshStandardMaterial({
      map: membraneTex,
      roughness: 0.7,
      metalness: 0.05,
      side: THREE.DoubleSide,
      envMapIntensity: 0.5,
    });
    const solarMat = new THREE.MeshStandardMaterial({
      map: track(solarTexture()),
      roughness: 0.3,
      metalness: 0.55,
      side: THREE.DoubleSide,
      envMapIntensity: 1.0,
    });
    const roof = new THREE.Mesh(
      track(new THREE.BoxGeometry(layout.canopy.width, 0.14, layout.canopy.depth)),
      membraneMat,
    );
    roof.rotation.z = 0.018;
    roof.position.set(0, layout.canopy.height + 0.36, 0);
    roof.castShadow = true;
    roof.receiveShadow = true;
    // 包边 fascia
    const fasciaMat = new THREE.MeshStandardMaterial({ color: 0x8b95a1, metalness: 0.6, roughness: 0.4 });
    const fasciaF = new THREE.Mesh(track(new THREE.BoxGeometry(layout.canopy.width + 0.2, 0.3, 0.08)), fasciaMat);
    fasciaF.position.set(0, layout.canopy.height + 0.32, layout.canopy.depth / 2);
    const fasciaB = fasciaF.clone();
    fasciaB.position.z = -layout.canopy.depth / 2;
    canopyG.add(roof, fasciaF, fasciaB);
    scene.add(canopyG);

    // ---------------------------------------------------------- 围栏 / 大门 / 储能箱
    {
      const picketGeo = track(new THREE.BoxGeometry(0.14, 1.15, 0.05));
      const picketMat = new THREE.MeshStandardMaterial({ color: 0xf0f3f6, roughness: 0.75 });
      const positions: [number, number, number, number][] = [];
      const hw = layout.canopy.width / 2 + 5.4;
      const hd = layout.canopy.depth / 2 + 5.2;
      for (let x = -hw; x <= hw; x += 0.55) {
        if (Math.abs(x) < 3.4) continue; // 大门缺口
        positions.push([x, 0.58, -hd, 0]);
        positions.push([x, 0.58, hd, 0]);
      }
      for (let z = -hd; z <= hd; z += 0.55) {
        positions.push([-hw, 0.58, z, 1]);
        positions.push([hw, 0.58, z, 1]);
      }
      const inst = new THREE.InstancedMesh(picketGeo, picketMat, positions.length);
      const mtx = new THREE.Matrix4();
      const eul = new THREE.Euler();
      positions.forEach(([x, y, z, side], i) => {
        eul.set(0, side ? Math.PI / 2 : 0, 0);
        mtx.makeRotationFromEuler(eul);
        mtx.setPosition(x, y, z);
        inst.setMatrixAt(i, mtx);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      scene.add(inst);
      // 顶部横杆
      const railMat = new THREE.MeshStandardMaterial({ color: 0xdde2e8, roughness: 0.7 });
      for (const sz of [-1, 1]) {
        const rail = new THREE.Mesh(track(new THREE.BoxGeometry(hw * 2, 0.08, 0.08)), railMat);
        rail.position.set(0, 1.12, sz * hd);
        scene.add(rail);
      }
      for (const sx of [-1, 1]) {
        const rail = new THREE.Mesh(track(new THREE.BoxGeometry(0.08, 0.08, hd * 2)), railMat);
        rail.position.set(sx * hw, 1.12, 0);
        scene.add(rail);
      }
    }
    // 地标柱 + 发光条 + 站名
    {
      const pylon = new THREE.Mesh(
        track(new RoundedBoxGeometry(1.4, 9, 1.4, 3, 0.12)),
        new THREE.MeshStandardMaterial({
          color: 0x2563eb,
          emissive: 0x1d4ed8,
          emissiveIntensity: 0.4,
          roughness: 0.35,
          envMapIntensity: 0.8,
        }),
      );
      pylon.position.set(layout.canopy.width / 2 + 3.2, 4.5, -layout.canopy.depth / 2 - 3.4);
      pylon.castShadow = true;
      const strip = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.12, 8.2, 0.12)),
        new THREE.MeshStandardMaterial({ color: 0x0b1c33, emissive: CYAN, emissiveIntensity: 1.6 }),
      );
      strip.position.set(-0.45, 0, 0.72);
      pylon.add(strip);
      scene.add(pylon);
      const sign = labelSprite('国扑充电站', 'CHARGING STATION');
      sign.position.set(layout.canopy.width / 2 - 1.5, 3.4, layout.canopy.depth / 2 + 4.6);
      scene.add(sign);
    }
    // 储能集装箱（波纹 + 门闩）
    {
      const boxMat = new THREE.MeshStandardMaterial({
        map: track(containerTexture()),
        roughness: 0.55,
        metalness: 0.35,
        envMapIntensity: 0.7,
      });
      const doorMat = new THREE.MeshStandardMaterial({ color: 0x5d6670, roughness: 0.7 });
      for (let i = 0; i < 4; i += 1) {
        const bx = -layout.canopy.width / 2 + 2.5 + i * 3.4;
        const bz = -layout.canopy.depth / 2 - 3.2;
        const box = new THREE.Mesh(track(new THREE.BoxGeometry(3.0, 2.5, 2.2)), boxMat);
        box.position.set(bx, 1.25, bz);
        box.castShadow = true;
        box.receiveShadow = true;
        const door = new THREE.Mesh(track(new THREE.BoxGeometry(2.6, 2.0, 0.06)), doorMat);
        door.position.set(bx, 1.2, bz + 1.12);
        scene.add(box, door);
      }
    }

    // ---------------------------------------------------------- 背景楼 / 树 / 路灯
    const { day: winDay, night: winNight } = facadeTextures();
    track(winDay);
    track(winNight);
    const bldMats: THREE.MeshStandardMaterial[] = [];
    const bldPositions: [number, number, number, number, number][] = [
      [-30, 14, -34, 14, 22],
      [-12, 20, -40, 16, 30],
      [28, 17, -36, 15, 26],
      [44, 12, -10, 12, 20],
    ];
    for (const [bx, bh, bz, bw, bd] of bldPositions) {
      const bm = new THREE.MeshStandardMaterial({
        map: winDay,
        emissiveMap: winNight,
        emissive: 0xffffff,
        emissiveIntensity: 0,
        roughness: 0.32,
        metalness: 0.55,
        envMapIntensity: 1.0,
      });
      bldMats.push(bm);
      const b = new THREE.Mesh(track(new THREE.BoxGeometry(bw, bh, bd)), bm);
      b.position.set(bx, bh / 2, bz);
      b.castShadow = true;
      scene.add(b);
      // 裙楼 + 女儿墙
      const podium = new THREE.Mesh(
        track(new THREE.BoxGeometry(bw + 1.5, 2.4, bd + 1.5)),
        new THREE.MeshStandardMaterial({ color: 0x6d7680, roughness: 0.8 }),
      );
      podium.position.set(bx, 1.2, bz);
      const parapet = new THREE.Mesh(
        track(new THREE.BoxGeometry(bw + 0.4, 0.7, bd + 0.4)),
        new THREE.MeshStandardMaterial({ color: 0x59616b, roughness: 0.8 }),
      );
      parapet.position.set(bx, bh + 0.3, bz);
      scene.add(podium, parapet);
    }
    {
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6e5138, roughness: 1 });
      const leafMatA = new THREE.MeshStandardMaterial({ color: 0x3f8a3e, roughness: 1 });
      const leafMatB = new THREE.MeshStandardMaterial({ color: 0x57a854, roughness: 1 });
      const trunkGeo = track(new THREE.CylinderGeometry(0.15, 0.22, 1.9, 8));
      const leafGeoL = track(new THREE.SphereGeometry(1.35, 12, 10));
      const leafGeoS = track(new THREE.SphereGeometry(0.95, 12, 10));
      const treeX = [-16, -10, 16, 22, -22, 26, -28, 10];
      treeX.forEach((tx, i) => {
        const tz = layout.canopy.depth / 2 + 9.6 + (i % 2) * 1.2;
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.set(tx, 0.95, tz);
        trunk.castShadow = true;
        const low = new THREE.Mesh(leafGeoL, i % 2 ? leafMatA : leafMatB);
        low.scale.y = 0.85;
        low.position.set(tx, 2.5, tz);
        low.castShadow = true;
        const top = new THREE.Mesh(leafGeoS, i % 2 ? leafMatB : leafMatA);
        top.position.set(tx + 0.25, 3.5, tz);
        top.castShadow = true;
        scene.add(trunk, low, top);
      });
    }
    const streetHeadMats: THREE.MeshStandardMaterial[] = [];
    const nightGlow: THREE.Object3D[] = [];
    {
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x4c535b, metalness: 0.7, roughness: 0.45 });
      for (const px of [-14, -5, 5, 14]) {
        const pz = layout.canopy.depth / 2 + 6.2;
        const pole = new THREE.Mesh(track(new THREE.CylinderGeometry(0.09, 0.13, 6.6, 10)), poleMat);
        pole.position.set(px, 3.3, pz);
        pole.castShadow = true;
        const armH = new THREE.Mesh(track(new THREE.BoxGeometry(0.12, 0.1, 1.6)), poleMat);
        armH.position.set(px, 6.55, pz - 0.7);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ec, emissive: 0xfff3c4, emissiveIntensity: 0.2 });
        streetHeadMats.push(headMat);
        const head = new THREE.Mesh(track(new RoundedBoxGeometry(0.34, 0.12, 0.9, 2, 0.05)), headMat);
        head.position.set(px, 6.5, pz - 1.4);
        // 光锥 + 地面光池（仅夜晚可见）
        const cone = new THREE.Mesh(
          track(new THREE.ConeGeometry(2.1, 5.6, 20, 1, true)),
          new THREE.MeshBasicMaterial({
            color: 0xffe6b0,
            transparent: true,
            opacity: 0.1,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        cone.position.set(px, 3.6, pz - 1.4);
        cone.visible = false;
        const pool = new THREE.Mesh(
          track(new THREE.PlaneGeometry(7.5, 7.5)),
          new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, opacity: 0.75 }),
        );
        pool.rotation.x = -Math.PI / 2;
        pool.position.set(px, 0.05, pz - 1.4);
        pool.visible = false;
        nightGlow.push(cone, pool);
        scene.add(pole, armH, head, cone, pool);
      }
    }

    // ---------------------------------------------------------- 状态应用函数
    const applyNight = (night: boolean) => {
      if (night) {
        skyMat.map = skyNightTex;
        scene.fog = new THREE.Fog(0x0b1220, 70, 190);
        sun.intensity = 0.22;
        sun.color.set(0xa9c4ff);
        hemi.intensity = 0.22;
        scene.environmentIntensity = 0.22;
        renderer.toneMappingExposure = 0.95;
      } else {
        skyMat.map = skyDayTex;
        scene.fog = new THREE.Fog(0xd8e6f3, 70, 170);
        sun.intensity = 2.4;
        sun.color.set(0xfff1da);
        hemi.intensity = 0.55;
        scene.environmentIntensity = 0.85;
        renderer.toneMappingExposure = 1.1;
      }
      skyMat.needsUpdate = true;
      for (const m of bldMats) m.emissiveIntensity = night ? 1.0 : 0;
      for (const m of streetHeadMats) m.emissiveIntensity = night ? 3.0 : 0.2;
      for (const { head, tail } of carLampMats) {
        head.emissiveIntensity = night ? 3.2 : 0.5;
        tail.emissiveIntensity = night ? 2.6 : 0.6;
      }
      for (const o of nightGlow) o.visible = night;
      padMat.emissiveIntensity = night ? 0.9 : 0.14;
    };
    const applyRoof = (solar: boolean) => {
      roof.material = solar ? solarMat : membraneMat;
    };
    const applyXray = (xray: boolean) => {
      for (const car of carRefs) {
        for (const bm of car.bodyMats) {
          bm.transparent = xray;
          bm.opacity = xray ? 0.26 : 1;
          bm.needsUpdate = true;
        }
        car.battery.visible = xray;
      }
    };
    const applySelection = (id: string | null) => {
      if (!id) {
        ring.visible = false;
        return;
      }
      const pile = P().layout.piles.find((q) => q.id === id);
      if (!pile) {
        ring.visible = false;
        return;
      }
      ring.visible = true;
      ring.position.set(pile.x, 0.06, pile.z + 0.6);
    };

    applyNight(P().night);
    applyRoof(P().solarRoof);
    applyXray(P().xray);
    applySelection(P().selectedPile);
    controls.autoRotate = P().roam;
    controls.autoRotateSpeed = 0.9;

    // ---------------------------------------------------------- 交互
    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    let downAt: [number, number] | null = null;

    const pickAt = (cx: number, cy: number) => {
      const r = renderer.domElement.getBoundingClientRect();
      ptr.x = ((cx - r.left) / r.width) * 2 - 1;
      ptr.y = -((cy - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ptr, camera);
      const hp = ray.intersectObjects(pileHit, false);
      if (hp.length > 0) {
        const id = (hp[0].object.userData.pileId ?? null) as string | null;
        P().onSelectPile(id);
        return;
      }
      const hc = ray.intersectObjects(carHit, true);
      if (hc.length > 0) {
        P().onCarClick();
        return;
      }
      P().onSelectPile(null);
    };

    const onDown = (e: PointerEvent) => {
      downAt = [e.clientX, e.clientY];
    };
    const onUp = (e: PointerEvent) => {
      if (!downAt) return;
      const dx = e.clientX - downAt[0];
      const dy = e.clientY - downAt[1];
      downAt = null;
      if (dx * dx + dy * dy < 36) pickAt(e.clientX, e.clientY);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    // ---------------------------------------------------------- 尺寸 / 循环
    const resize = () => {
      const w = mount.clientWidth || 800;
      const h = mount.clientHeight || 560;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.display = 'block';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    // 开场运镜：从高远推近到工作位（用 performance 计时，不依赖已废弃的 THREE.Clock）
    const introFrom = new THREE.Vector3(34, 26, 40);
    const introTo = new THREE.Vector3(17, 10, 22);
    camera.position.copy(introFrom);
    let introT = 0;
    let lastNow = performance.now();
    let elapsed = 0;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min((now - lastNow) / 1000, 0.05);
      lastNow = now;
      elapsed += dt;
      const t = elapsed;
      if (introT < 1) {
        introT = Math.min(1, introT + dt / 2.4);
        const k = 1 - Math.pow(1 - introT, 3);
        camera.position.lerpVectors(introFrom, introTo, k);
      }
      const cur = P();
      if (controls.autoRotate !== cur.roam) controls.autoRotate = cur.roam;
      // 充电呼吸灯 + 状态灯
      const pulse = 1.4 + Math.sin(t * 3) * 0.6;
      pileEdgeMats.forEach((m, i) => {
        const st = cur.layout.piles[i]?.status;
        m.emissiveIntensity = st === 'charging' ? pulse : st === 'fault' ? 2.2 : 0.35;
      });
      pileLampMats.forEach((m, i) => {
        if (cur.layout.piles[i]?.status === 'charging') m.emissiveIntensity = 1.6 + Math.sin(t * 3) * 0.8;
      });
      ring.rotation.z = t * 0.6;
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    // prop 变化的轻量同步（roam 在 loop 内同步，其余走 watcher）
    let lastNight = P().night;
    let lastSolar = P().solarRoof;
    let lastXray = P().xray;
    let lastSel = P().selectedPile;
    const syncTimer = window.setInterval(() => {
      const c = P();
      if (c.night !== lastNight) {
        lastNight = c.night;
        applyNight(c.night);
      }
      if (c.solarRoof !== lastSolar) {
        lastSolar = c.solarRoof;
        applyRoof(c.solarRoof);
      }
      if (c.xray !== lastXray) {
        lastXray = c.xray;
        applyXray(c.xray);
      }
      if (c.selectedPile !== lastSel) {
        lastSel = c.selectedPile;
        applySelection(c.selectedPile);
      }
    }, 120);

    return () => {
      window.clearInterval(syncTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      controls.dispose();
      pmrem.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose?.();
          const mt = mesh.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mt)) mt.forEach((m) => m.dispose());
          else mt?.dispose?.();
        }
        const sp = o as THREE.Sprite;
        if (sp.isSprite) {
          (sp.material as THREE.Material)?.dispose?.();
        }
      });
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* 忽略 */
        }
      }
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={mountRef} className="twin-canvas" data-testid="charge-scene" />;
}
