// Sky dome: blue sky with a bright horizon when the camera is low, fading out into space.
import * as THREE from 'three';

export class Sky {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      // Opaque pass (drawn first via renderOrder) with manual alpha blending, so terrain covers it.
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uAlpha: { value: 0 },
        uDay: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uUp;
        uniform float uAlpha;
        uniform float uDay;
        varying vec3 vDir;
        void main() {
          float e = dot(normalize(vDir), uUp);
          vec3 zenith = vec3(0.16, 0.36, 0.74);
          vec3 horizon = vec3(0.70, 0.82, 0.95);
          vec3 below = vec3(0.60, 0.72, 0.86);
          vec3 col = e > 0.0 ? mix(horizon, zenith, pow(e, 0.55)) : below;
          col *= 0.18 + 0.82 * uDay;
          gl_FragColor = vec4(col, uAlpha);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
  }

  get alpha(): number {
    return this.material.uniforms.uAlpha.value;
  }

  update(camera: THREE.Camera, day: number) {
    this.mesh.position.copy(camera.position);
    const altitude = camera.position.length() - 100;
    this.material.uniforms.uUp.value.copy(camera.position).normalize();
    // Fully blue under ~2 units (~130 km), gone above ~25.
    const t = Math.min(1, Math.max(0, (altitude - 2) / 23));
    this.material.uniforms.uAlpha.value = 1 - t * t * (3 - 2 * t);
    this.material.uniforms.uDay.value = day;
  }
}
