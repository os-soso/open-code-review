// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

/**
 * Reports whether this browser can give us a WebGL context.
 *
 * three.js announces a missing context by writing its own console errors
 * ("THREE.WebGLRenderer: A WebGL context could not be created",
 * "THREE.WebGLRenderer: Error creating WebGL context.") and then throwing out of
 * the WebGLRenderer constructor, so a caller that wants to degrade silently has
 * to decide *before* it constructs a renderer — catching the throw is too late,
 * the errors are already in the console.
 *
 * This module deliberately imports nothing. Keeping the probe here rather than
 * next to the shader component lets the landing page consult it without a static
 * import of `three`, which would pull the whole shader chunk into the main
 * bundle and defeat the lazy `color-bends` split.
 */
export function hasWebGLSupport(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const probe = document.createElement('canvas');
    const gl: WebGLRenderingContext | WebGL2RenderingContext | null =
      probe.getContext('webgl2') ??
      probe.getContext('webgl') ??
      // Not in the typed overload list; still worth asking for on old browsers.
      (probe.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (!gl) return false;
    // Contexts are a scarce per-document resource, so hand the probe's context
    // back immediately instead of waiting for it to be garbage collected. The
    // extension is declared on both context interfaces; the assertion just picks
    // one of the two overload sets so the call resolves on the union.
    (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    // A browser that throws from getContext — privacy blocking, a blocklisted
    // driver — has no usable WebGL either.
    return false;
  }
}
