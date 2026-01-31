#version 300 es
#defines

precision highp float;
precision highp sampler2D;

out highp vec4 fragColor;

uniform sampler2D u_texture;
uniform sampler2D u_textureNext;

uniform sampler2D u_particles;

uniform float u_fade_t;
uniform vec2 u_image_res;

uniform vec4 u_bbox; // 当前地图范围
uniform vec4 u_data_bbox; // 数据范围
uniform float u_rand_seed;
uniform float u_drop_rate;
uniform float u_drop_rate_bump;
uniform float u_speed_factor;
uniform bool u_initialize;
uniform bool u_flip_y;
uniform float u_gl_scale;
uniform float u_max_age;  // Maximum particle age in frames (0 = use probabilistic drop)
uniform float u_min_lifespan_percent;  // Respawn age spread: 0-1, particles respawn with age 0 to (this * maxAge)
uniform float u_force_velocity;  // Phase 5 Exp I: if > 0, override velocity with constant eastward value

in vec2 vUv;

// Flag to control whether particles should be dropped during update.
// During initialization spreading, we don't want to drop particles.
bool g_allow_drop = true;

#include <random>

vec4 calcTexture(const vec2 puv) {
    vec4 color0 = texture(u_texture, puv);
    vec4 color1 = texture(u_textureNext, puv);

    return mix(color0, color1, u_fade_t);
}

vec2 decodeValue(const vec2 vc) {
    vec4 rgba = calcTexture(vc);
    return rgba.rg;
}

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

// Map random 0-1 position to the DATA bounds (not viewport bounds).
// This ensures particles are uniformly distributed across the actual data coverage area,
// preventing clustering when viewport and data bounds differ.
vec2 randomPosToDataPos(vec2 pos) {
    vec2 min_bbox = u_data_bbox.xy;
    vec2 max_bbox = u_data_bbox.zw;
    return mix(min_bbox, max_bbox, pos);
}

// Legacy function kept for compatibility - maps to viewport bounds
vec2 randomPosToGlobePos(vec2 pos) {
    vec2 min_bbox = u_bbox.xy;
    vec2 max_bbox = u_bbox.zw;
    return mix(min_bbox, max_bbox, pos);
}

bool containsXY(vec2 pos, vec4 bbox) {
    float x = pos.x;
    return (
    bbox.x <= x && x <= bbox.z &&
    bbox.y <= pos.y && pos.y <= bbox.w
    );
}

// Returns vec3(pos.x, pos.y, age)
vec3 update(vec2 pos, float age) {
    // Convert particle position to UV coordinates relative to data bounds
    vec2 uv = (pos.xy - u_data_bbox.xy) / (u_data_bbox.zw - u_data_bbox.xy); // 0-1

    if (u_flip_y) {
        uv = vec2(uv.x, 1.0 - uv.y);
    }

    // Only sample velocity if particle is within data bounds.
    // Particles outside data bounds stay stationary (velocity = 0).
    vec2 velocity = vec2(0.0);
    float speed = 0.0;
    bool inDataBounds = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;

    if (inDataBounds) {
        velocity = bilinear(uv);
        speed = length(velocity);

        // Phase 5 Exp I: optionally override velocity with a constant eastward value
        if (u_force_velocity > 0.0) {
            velocity = vec2(u_force_velocity, 0.0);
            speed = u_force_velocity;
        }

        // For RG-encoded velocity data (currents), no-data/land is encoded as PNG value 127
        // which decodes to approximately 0 m/s for both U and V components.
        // Particles over land/no-data (speed < 0.02 m/s / ~0.04 knots) stay stationary.
        // They will be hidden by the draw shader and naturally respawn via drop_rate.
        if (speed >= 0.02) {
            vec2 v = vec2(velocity.x, -velocity.y);

            if (u_flip_y) {
                v = vec2(velocity.x, velocity.y);
            }

            vec2 offset = v * 0.0001 * u_speed_factor * u_gl_scale;
            pos = pos + offset;
        }
    }

    // Increment age each frame
    age += 1.0;

    // Skip drop logic if dropping is disabled (during initialization spread)
    if (!g_allow_drop) {
        return vec3(pos, age);
    }

    // a random seed to use for the particle drop
    vec2 seed = (pos.xy + vUv) * u_rand_seed;

    float drop = 0.0;

    // Use deterministic age-based lifespan if u_max_age > 0
    if (u_max_age > 0.0) {
        // Drop particle when it exceeds max age
        drop = step(u_max_age, age);
    } else {
        // Use probabilistic drop rate (original behavior)
        float drop_rate = u_drop_rate + speed * u_drop_rate_bump;
        drop = step(1.0 - drop_rate, rand(seed));
    }

    // Generate random position within VIEWPORT bounds (u_bbox).
    // This ensures particles respawn uniformly across the entire visible area,
    // not just the area with loaded data tiles.
    vec2 random_pos = vec2(rand(seed + 1.3), rand(seed + 2.1));
    random_pos = randomPosToGlobePos(random_pos);

    // Force-drop particles that have moved outside the VIEWPORT bounds.
    // NOTE: We do NOT force-drop particles over land/no-data areas.
    // Particles over land are kept stationary (no position update) and hidden by the draw shader.
    // Force-dropping them would cause clustering because respawned particles that land
    // on land areas would immediately drop again, creating a feedback loop.
    // Instead, the natural drop_rate gradually redistributes land particles over time.
    if (!containsXY(pos.xy, u_bbox)) {
        drop = 1.0;
    }

    // Reset age when dropped - random offset staggers respawns to prevent pulsing
    // u_min_lifespan_percent controls spread (0.5 = 50% of maxAge, balances pulse vs lifespan)
    float random_age = rand(seed + 3.7) * u_min_lifespan_percent * u_max_age;
    age = mix(age, random_age, drop);

    pos = mix(pos, random_pos, drop);

    return vec3(pos, age);
}

void main() {
    vec4 particle = texture(u_particles, vUv);
    vec2 pos = particle.xy;
    float age = particle.z;

    // During initialization, map random positions to VIEWPORT bounds (u_bbox).
    // We use viewport bounds instead of data bounds because:
    // 1. Data bounds (u_data_bbox) only covers currently loaded tiles
    // 2. After a pan, not all tiles may be loaded yet
    // 3. Using viewport bounds ensures particles are distributed across the entire view
    // 4. Particles in areas without data will be invisible but won't cluster
    if (u_initialize) {
        // Convert initial random 0-1 position (scaled by glScale) back to 0-1 range,
        // then map to viewport bounds for uniform coverage across the visible area.
        vec2 normalized_pos = pos / u_gl_scale;
        pos = randomPosToGlobePos(normalized_pos);

        // Initialize age to random value so particles don't all die at once
        vec2 seed = vUv * u_rand_seed;
        age = rand(seed) * max(u_max_age, 300.0);

        // Don't call update() during initialization - just set the random position.
        // Calling update() would sample velocity from potentially incomplete data texture,
        // causing particles to drift toward areas with loaded data.
    } else {
        vec3 result = update(pos, age);
        pos = result.xy;
        age = result.z;
    }

    fragColor = vec4(pos.xy, age, 1.0);
}
