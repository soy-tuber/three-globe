// Terrain shader shared by the global sphere and the high-resolution regional patches.
//
// Geometry UVs are *global* equirectangular (u: lng −180→180, v: lat −90→90); each material maps
// them into its own region's textures. Land is displaced by the DEM; the sea surface stays flat and
// the seabed shows through the colour only. Normals are derived per-pixel from the height texture
// so relief shading is as sharp as the DEM, independent of mesh density.
import * as THREE from 'three';
import type { TerrainRegion } from './terrainData';

export const METRES_TO_UNITS = 100 / 6371008.8;

const vertexShader = /* glsl */ `
  uniform sampler2D uHeight;
  uniform sampler2D uMask;
  uniform vec4 uBBox;
  uniform float uExag;
  #ifdef SKIRT
  attribute float skirt;
  #endif
  varying vec2 vGeo;
  varying vec3 vWorld;
  varying vec3 vUp;

  void main() {
    vec2 geo = vec2(uv.x * 360.0 - 180.0, uv.y * 180.0 - 90.0);
    vGeo = geo;
    vec2 tuv = (geo - uBBox.xy) / (uBBox.zw - uBBox.xy);
    float h = textureLod(uHeight, tuv, 0.0).r;
    float land = textureLod(uMask, tuv, 0.0).r;
    float disp = max(h, 0.0) * land * uExag * ${METRES_TO_UNITS.toExponential(8)};
    vec3 up = normalize(position);
    vec3 p = position + up * disp;
    #ifdef SKIRT
    p -= up * skirt * 0.25;
    #endif
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorld = wp.xyz;
    vUp = normalize(mat3(modelMatrix) * up);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uAlbedo;
  uniform sampler2D uHeight;
  uniform sampler2D uMask;
  uniform vec4 uBBox;
  uniform vec2 uHeightSize;
  uniform float uExag;
  uniform vec4 uHoles[4];
  uniform int uHoleCount;
  uniform vec3 uSunDir;
  uniform float uRealSun;
  uniform float uTime;
  uniform float uHazeDensity;
  uniform vec3 uHazeColor;
  varying vec2 vGeo;
  varying vec3 vWorld;
  varying vec3 vUp;

  float hAt(vec2 tuv) { return max(texture(uHeight, tuv).r, 0.0); }

  // Value noise for close-range surface detail (the source rasters are ~1 km/px).
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float detail(vec2 geo) {
    vec2 p = geo * vec2(cos(radians(geo.y)), 1.0) * 220.0;
    // Fade each octave out before it aliases.
    float fw = length(fwidth(p));
    float n = 0.0, amp = 0.5, tot = 0.0;
    for (int o = 0; o < 4; o++) {
      float fade = 1.0 - smoothstep(0.25, 0.7, fw);
      n += (vnoise(p) - 0.5) * amp * fade;
      tot += amp;
      p *= 2.13;
      fw *= 2.13;
      amp *= 0.55;
    }
    return n / tot;
  }

  void main() {
    for (int i = 0; i < 4; i++) {
      if (i >= uHoleCount) break;
      vec4 h = uHoles[i];
      if (vGeo.x > h.x && vGeo.x < h.z && vGeo.y > h.y && vGeo.y < h.w) discard;
    }

    vec2 tuv = (vGeo - uBBox.xy) / (uBBox.zw - uBBox.xy);
    vec3 albedo = texture(uAlbedo, tuv).rgb;
    vec3 mask = texture(uMask, tuv).rgb;
    float land = mask.r;
    float lights = mask.g;
    float water = max(1.0 - land, mask.b);
    albedo *= 1.0 + detail(vGeo) * 0.35 * land;

    // Local frame.
    vec3 up = normalize(vUp);
    vec3 east = cross(vec3(0.0, 1.0, 0.0), up);
    east = length(east) < 1e-4 ? vec3(1.0, 0.0, 0.0) : normalize(east);
    vec3 north = cross(up, east);

    // Relief normal from the DEM (central differences, metres → slope). The sampling offset grows
    // with the pixel footprint so distant terrain doesn't sparkle.
    vec2 texel = max(1.0 / uHeightSize, fwidth(tuv) * 0.8);
    float hL = hAt(tuv - vec2(texel.x, 0.0));
    float hR = hAt(tuv + vec2(texel.x, 0.0));
    float hD = hAt(tuv - vec2(0.0, texel.y));
    float hU = hAt(tuv + vec2(0.0, texel.y));
    float mX = texel.x * (uBBox.z - uBBox.x) * 111320.0 * max(cos(radians(vGeo.y)), 0.05);
    float mY = texel.y * (uBBox.w - uBBox.y) * 111320.0;
    float shadeExag = uExag * 1.5;
    vec2 grad = vec2((hR - hL) / (2.0 * mX), (hU - hD) / (2.0 * mY)) * shadeExag * land;
    vec3 n = normalize(up - east * grad.x - north * grad.y);

    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorld);
    float ndl = dot(n, L);
    float upl = dot(up, L);

    // uRealSun = 0: "studio" light that follows the camera; 1: real sun with day/night.
    float day = mix(1.0, smoothstep(-0.1, 0.2, upl), uRealSun);

    vec3 sunCol = vec3(1.0, 0.96, 0.9);
    vec3 skyCol = vec3(0.52, 0.66, 0.92);

    float wrap = max((ndl + 0.3) / 1.3, 0.0);
    float light = mix(wrap, max(ndl, 0.0), 0.55);
    // Slopes facing away from the light get a touch of cool sky light (aerial perspective).
    vec3 col = albedo * (sunCol * light * 1.18 * day + skyCol * (0.2 + 0.1 * day));

    // Water: sun glint. The studio light sits near the camera, so its glint is kept subtle.
    vec3 H = normalize(L + V);
    float nh = max(dot(up, H), 0.0);
    float spec = (pow(nh, 220.0) * 1.1 + pow(nh, 30.0) * 0.06) * mix(0.12, 1.0, uRealSun);
    float fres = pow(1.0 - max(dot(up, V), 0.0), 4.0);
    col += water * sunCol * spec * day * smoothstep(-0.05, 0.1, upl);
    col = mix(col, skyCol * (0.25 + 0.55 * day), water * fres * 0.55);

    // City lights on the night side (real-sun mode only).
    float night = (1.0 - smoothstep(-0.22, 0.04, upl)) * uRealSun;
    col += vec3(1.0, 0.7, 0.36) * pow(lights, 1.6) * night * 1.4;

    // Atmospheric haze toward the limb.
    float rim = pow(1.0 - max(dot(up, V), 0.0), 3.0);
    col = mix(col, vec3(0.42, 0.64, 1.0) * (0.2 + 0.8 * day), rim * 0.5);

    // Aerial perspective when flying low.
    float dist = length(cameraPosition - vWorld);
    float haze = 1.0 - exp(-dist * uHazeDensity);
    col = mix(col, uHazeColor * (0.25 + 0.75 * day), haze * 0.75);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface TerrainUniforms {
  uExag: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uRealSun: { value: number };
  uTime: { value: number };
  uHazeDensity: { value: number };
  uHazeColor: { value: THREE.Color };
}

export function createTerrainMaterial(
  region: TerrainRegion,
  shared: TerrainUniforms,
  opts: { holes?: [number, number, number, number][]; skirt?: boolean } = {},
): THREE.ShaderMaterial {
  const [w, s, e, n] = region.meta.bbox;
  const holes = (opts.holes ?? []).slice(0, 4);
  const holeVecs = Array.from({ length: 4 }, (_, i) => new THREE.Vector4(...(holes[i] ?? [0, 0, -1, -1])));
  return new THREE.ShaderMaterial({
    side: opts.skirt ? THREE.DoubleSide : THREE.FrontSide,
    vertexShader,
    fragmentShader,
    defines: opts.skirt ? { SKIRT: '' } : {},
    uniforms: {
      uAlbedo: { value: region.albedoTex },
      uHeight: { value: region.heightTex },
      uMask: { value: region.maskTex },
      uBBox: { value: new THREE.Vector4(w, s, e, n) },
      uHeightSize: { value: new THREE.Vector2(region.meta.height.width, region.meta.height.height) },
      uHoles: { value: holeVecs },
      uHoleCount: { value: holes.length },
      ...shared,
    },
  });
}
