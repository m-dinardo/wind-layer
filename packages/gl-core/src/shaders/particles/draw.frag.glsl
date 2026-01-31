#defines

precision highp float;

uniform sampler2D u_texture;
uniform sampler2D u_textureNext;
uniform vec2 u_colorRange;
uniform sampler2D u_colorRamp;

uniform vec4 u_bbox;
uniform vec4 u_data_bbox;
uniform float u_fade_t;
uniform vec2 u_image_res;
uniform bool u_flip_y;
uniform float u_debug_mode;

varying vec2 v_particle_pos;

vec4 calcTexture(const vec2 puv) {
    vec4 color0 = texture2D(u_texture, puv);
    vec4 color1 = texture2D(u_textureNext, puv);

    return mix(color0, color1, u_fade_t);
}

#if RENDER_TYPE == 1
// rg
vec2 decodeValue(const vec2 vc) {
    vec4 rgba = calcTexture(vc);
    return rgba.rg;
}
#else
float decodeValue(const vec2 vc) {
    return calcTexture(vc).r;
}
#endif

vec2 bilinear(const vec2 uv) {
    vec2 px = 1.0 / u_image_res;
    vec2 vc = (floor(uv * u_image_res)) * px;
    vec2 f = fract(uv * u_image_res);
    vec2 tl = decodeValue(vc);
    vec2 tr = decodeValue(vc + vec2(px.x, 0));
    vec2 bl = decodeValue(vc + vec2(0, px.y));
    vec2 br = decodeValue(vc + px);
    return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

bool containsXY(vec2 pos, vec4 bbox) {
    float x = pos.x;
    return (
    bbox.x < x && x < bbox.z &&
    bbox.y < pos.y && pos.y < bbox.w
    );
}

void main() {
    vec2 pos = v_particle_pos;

    // Debug modes: 0=normal, 1=bypass both, 2=normal proj + skip discards, 3=NDC + normal discards
    // 4=centered proj + skip discards
    // Modes 1, 2, and 4: bypass fragment discard logic, output position as color
    if ((u_debug_mode > 0.5 && u_debug_mode < 2.5) || u_debug_mode > 3.5) {
        float distance = length(2.0 * gl_PointCoord - 1.0);
        if (distance > 1.0) {
            discard;
        }
        // Mode 4: tint blue to visually confirm centered projection is active
        if (u_debug_mode > 3.5) {
            gl_FragColor = vec4(pos.x, pos.y, 1.0, 1.0);
        } else {
            gl_FragColor = vec4(pos.x, pos.y, 0.5, 1.0);
        }
        return;
    }
    // Mode 3: NDC projection but normal fragment logic (falls through to normal path below)

    // First check if particle is within both data and viewport bounds
    if (!containsXY(pos.xy, u_data_bbox) || !containsXY(pos.xy, u_bbox)) {
        discard;
    }

    // Convert world position to UV coordinates for texture sampling
    vec2 uv = (pos.xy - u_data_bbox.xy) / (u_data_bbox.zw - u_data_bbox.xy);

    // Apply Y-flip if needed (some map coordinate systems have inverted Y)
    if (u_flip_y) {
        uv = vec2(uv.x, 1.0 - uv.y);
    }

    // Check if we have valid data at this position (alpha > threshold)
    // Use a threshold rather than exact comparison to handle floating point precision
    vec4 texData = calcTexture(uv);
    if (texData.a < 0.01) {
        discard;
    }

    vec2 velocity = bilinear(uv);
    float value = length(velocity);

    // Discard particles over land/no-data areas.
    // For RG-encoded velocity data (currents), no-data/land is encoded as PNG value 127
    // which decodes to approximately 0 m/s for both U and V components.
    // We discard particles where the velocity magnitude is very small (< 0.02 m/s / ~0.04 knots).
    if (value < 0.02) {
        discard;
    }

    float value_t = (value - u_colorRange.x) / (u_colorRange.y - u_colorRange.x);
    vec2 ramp_pos = vec2(value_t, 0.5);

    vec4 color = texture2D(u_colorRamp, ramp_pos);

    float distance = length(2.0 * gl_PointCoord - 1.0);
    if (distance > 1.0) {
        discard;
    }

    gl_FragColor = vec4(floor(255.0 * color * color.a) / 255.0);
}
