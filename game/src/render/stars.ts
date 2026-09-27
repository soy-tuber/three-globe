// Procedural starfield (no texture download): a few thousand points with a realistic
// magnitude distribution and subtle colour temperature variation.
import * as THREE from 'three';

export function createStarfield(count = 6000, radius = 900): THREE.Points {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // Uniform on the sphere, with a denser band to hint at the Milky Way.
    let z = rnd() * 2 - 1;
    const band = rnd() < 0.35;
    if (band) z *= 0.18;
    const t = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    const v = new THREE.Vector3(r * Math.cos(t), z, r * Math.sin(t)).applyAxisAngle(new THREE.Vector3(1, 0, 0.3).normalize(), 1.05);
    v.multiplyScalar(radius).toArray(pos, i * 3);
    const mag = Math.pow(rnd(), 6); // most stars faint
    size[i] = 0.6 + mag * 3.2;
    const temp = rnd();
    c.setHSL(temp < 0.2 ? 0.08 : temp > 0.8 ? 0.6 : 0.6, temp < 0.2 || temp > 0.8 ? 0.5 : 0.1, 0.55 + mag * 0.45);
    c.toArray(col, i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) }, uOpacity: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float size;
      uniform float uPixelRatio;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uPixelRatio;
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w * 0.99999; // always at the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, a * uOpacity);
      }`,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  points.renderOrder = -10;
  return points;
}
