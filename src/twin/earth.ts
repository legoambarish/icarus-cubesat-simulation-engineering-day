/**
 * EARTH
 * =============================================================================
 * A single sphere with a custom shader rather than a MeshStandardMaterial,
 * because the scene has exactly one light (the Sun) and we want three things
 * that a stock PBR material will not give us cheaply:
 *
 *   1. a readable terminator - a soft day/night boundary, not a hard edge
 *   2. night-side city lights that fade in exactly where the day fades out
 *   3. a specular highlight on the ocean only, from the ocean mask
 *
 * The mesh is rotated about the render frame's +Y axis by GMST so that the
 * geography lines up with the ECI positions of the satellites (see
 * orbit/frames.ts - earthSpinFromGmst).
 */

import { Color, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Texture } from 'three';
import { EARTH_RADIUS_KM, unitsFromKm } from '../orbit/frames.ts';
import { buildEarthTextures, type EarthTextures } from './earthTexture.ts';
import { createAtmosphere, type AtmosphereObject } from './atmosphere.ts';

export const EARTH_RADIUS_UNITS = unitsFromKm(EARTH_RADIUS_KM);

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vPosW = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D landMask;
  uniform vec3 sunDirection;   // world space, unit
  uniform vec3 ambientColor;
  uniform float nightIntensity;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 L = normalize(sunDirection);
    vec3 V = normalize(cameraPosition - vPosW);

    float ndl = dot(N, L);

    // Soft terminator. The band is wide enough to read from a projector but
    // narrow enough that the planet still looks like a lit sphere.
    float day = smoothstep(-0.18, 0.28, ndl);

    vec3 dayColor = texture2D(dayMap, vUv).rgb;
    vec3 nightColor = texture2D(nightMap, vUv).rgb;
    float land = texture2D(landMask, vUv).r;

    // Lambert with a slight wrap so the limb does not go flat black.
    float diffuse = clamp(ndl * 0.92 + 0.08, 0.0, 1.0);
    vec3 lit = dayColor * diffuse;

    // Ocean specular: Blinn-Phong, masked to water, and only near the
    // sub-solar point so it reads as a glint rather than a shiny ball.
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 46.0) * (1.0 - land) * day;
    lit += vec3(0.42, 0.56, 0.66) * spec * 0.7;

    // Atmospheric forward-scattering towards the limb on the day side.
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.2);
    lit += vec3(0.22, 0.42, 0.72) * fres * day * 0.55;

    // City lights, strongest well into the night side.
    float nightFactor = 1.0 - smoothstep(-0.22, 0.06, ndl);
    vec3 lights = nightColor * nightFactor * nightIntensity;

    vec3 color = lit + lights + dayColor * ambientColor * 0.14;

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface EarthObject {
  mesh: Mesh;
  /** Thin outer shell that produces the blue rim. */
  atmosphere: AtmosphereObject;
  textures: EarthTextures;
  setSunDirection: (dir: Vector3) => void;
  /** Rotate the geography to match GMST (radians). */
  setSpin: (radians: number) => void;
  dispose: () => void;
}

export function createEarth(): EarthObject {
  const textures = buildEarthTextures();

  const material = new ShaderMaterial({
    uniforms: {
      dayMap: { value: textures.day as Texture },
      nightMap: { value: textures.night as Texture },
      landMask: { value: textures.mask as Texture },
      sunDirection: { value: new Vector3(1, 0, 0) },
      ambientColor: { value: new Color(0x2a3d52) },
      nightIntensity: { value: 1.25 },
    },
    vertexShader,
    fragmentShader,
  });

  // 96x64 is plenty: the silhouette is smooth at any sane camera distance and
  // it keeps the draw cheap. Higher segment counts buy nothing visible here.
  const geometry = new SphereGeometry(EARTH_RADIUS_UNITS, 96, 64);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'Earth';
  mesh.renderOrder = 0;

  const atmosphere = createAtmosphere(EARTH_RADIUS_UNITS);
  mesh.add(atmosphere.mesh);

  return {
    mesh,
    atmosphere,
    textures,
    setSunDirection: (dir) => {
      (material.uniforms.sunDirection!.value as Vector3).copy(dir);
      // The shell is a sphere, so its parent's spin does not affect it: the
      // Sun direction stays in world space for both materials.
      atmosphere.setSunDirection(dir);
    },
    setSpin: (radians) => {
      mesh.rotation.y = radians;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
      atmosphere.dispose();
      textures.dispose();
    },
  };
}
