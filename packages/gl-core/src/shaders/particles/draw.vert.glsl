precision highp sampler2D;

attribute vec2 reference;

attribute float a_index;

uniform vec2 resolution;
uniform mat4 modelViewMatrix;
uniform mat4 viewMatrix;
uniform mat4 modelMatrix;
uniform mat4 projectionMatrix;

uniform sampler2D u_particles;
uniform sampler2D u_particles_next;

uniform float u_particleSize;
uniform float u_particlesRes;
uniform float u_debug_mode;
uniform vec2 u_center;
uniform vec4 u_bbox;

varying vec2 v_particle_pos;

void main() {
    float v_index = floor(a_index / 6.0);
    vec2 uv = reference;
    vec4 color = texture2D(u_particles, uv);
    vec4 color1 = texture2D(u_particles_next, uv);

    v_particle_pos = mix(color.rg, color1.rg, 0.0);

    gl_PointSize = u_particleSize;

    // Debug modes:
    // 0 = normal production projection
    // 1 = NDC (bypass projection), no discards
    // 2 = normal projection, no discards
    // 3 = NDC, normal discards
    // 4 = bbox-based orthographic projection, no discards (bypasses matrix entirely)
    if (u_debug_mode > 0.5 && u_debug_mode < 1.5) {
        // Mode 1: NDC direct
        vec2 clipPos = v_particle_pos * 2.0 - 1.0;
        gl_Position = vec4(clipPos, 0.0, 1.0);
    } else if (u_debug_mode > 1.5 && u_debug_mode < 2.5) {
        // Mode 2: normal projection (for testing with no discards)
        gl_Position = projectionMatrix * modelViewMatrix * vec4(v_particle_pos, 0.0, 1.0);
    } else if (u_debug_mode > 2.5 && u_debug_mode < 3.5) {
        // Mode 3: NDC, normal discards
        vec2 clipPos = v_particle_pos * 2.0 - 1.0;
        gl_Position = vec4(clipPos, 0.0, 1.0);
    } else if (u_debug_mode > 3.5) {
        // Mode 4: bbox-based orthographic projection (no matrix at all)
        // Maps particle positions from u_bbox range to NDC [-1, 1]
        vec2 bboxMin = u_bbox.xy;
        vec2 bboxSize = u_bbox.zw - u_bbox.xy;
        vec2 ndc = (v_particle_pos - bboxMin) / bboxSize * 2.0 - 1.0;
        gl_Position = vec4(ndc, 0.0, 1.0);
    } else {
        // Mode 0: normal production projection
        gl_Position = projectionMatrix * modelViewMatrix * vec4(v_particle_pos, 0.0, 1.0);
    }
}

