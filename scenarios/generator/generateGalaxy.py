import argparse
from pathlib import Path

import agama
import numpy as np


GALAXY_SCALE = 5.0
DEFAULT_SMBH_MASS = 100000.0
BACKEND_SOFTENING_SQ = 0.1
DEFAULT_SMBH_EXCLUSION_RADIUS = 20.0 * GALAXY_SCALE
DEFAULT_SMBH_TAPER_POWER = 3.0
DEFAULT_SMBH_SINK_RADIUS = 0.30 * DEFAULT_SMBH_EXCLUSION_RADIUS

DEFAULT_ARM_COUNT = 2
DEFAULT_ARM_PITCH_DEG = 16.0
DEFAULT_ARM_STRENGTH = 0.50
DEFAULT_ARM_WIDTH = 0.55

PRESET_STABLE = "stable"
PRESET_GRAND_DESIGN = "grand-design"
PRESET_CINEMATIC = "cinematic"
PRESET_CHOICES = (PRESET_STABLE, PRESET_GRAND_DESIGN, PRESET_CINEMATIC)
DEFAULT_PRESET = PRESET_GRAND_DESIGN

DEFAULT_WARP_START_FACTOR = 2.5
DEFAULT_WARP_STRENGTH = 0.26
DEFAULT_FLARE_STRENGTH = 0.48

DEFAULT_BULGE_MASS_SCALE = 1.0
DEFAULT_BULGE_COMPACTNESS = 1.15

DEFAULT_CLUSTER_COUNT = 4
DEFAULT_CLUSTER_PARTICLE_FRACTION = 0.025
DEFAULT_CLUSTER_MASS_FRACTION = 0.008
DEFAULT_CLUSTER_SPREAD = 2.2 * GALAXY_SCALE


def write_agama_binary_snapshot(output_path, positions, velocities, masses, forces):
    # Binary layout must match backend/scenarios.cpp loader.
    # [u32 magic='AGM1'][u32 count][count * (x y z vx vy vz fx fy fz mass as f32)]
    positions = np.asarray(positions, dtype=np.float32)
    velocities = np.asarray(velocities, dtype=np.float32)
    masses = np.asarray(masses, dtype=np.float32).reshape(-1, 1)
    forces = np.asarray(forces, dtype=np.float32)

    count = positions.shape[0]
    if velocities.shape[0] != count or masses.shape[0] != count or forces.shape[0] != count:
        raise ValueError("positions/velocities/masses/forces length mismatch")

    rows = np.hstack([positions, velocities, forces, masses]).astype(np.float32, copy=False)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    magic = np.array([0x314D4741], dtype=np.uint32)  # 'AGM1' in little-endian
    n = np.array([count], dtype=np.uint32)
    with out.open("wb") as fp:
        fp.write(magic.tobytes())
        fp.write(n.tobytes())
        fp.write(rows.tobytes())

    print(f"Wrote AGAMA binary snapshot: {out} ({count} bodies)")


def component_counts(num_particles, fractions):
    # Largest-remainder assignment keeps total exact and preserves fractions closely.
    targets = np.array(fractions, dtype=np.float64) * float(num_particles)
    base = np.floor(targets).astype(np.int64)
    remainder = int(num_particles - int(base.sum()))
    if remainder > 0:
        order = np.argsort(-(targets - base))
        base[order[:remainder]] += 1
    return base


def sample_exponential_disk(n, r_scale, z_scale, rng):
    # Surface density Sigma(R) ~ exp(-R/Rd) => R follows Gamma(k=2, theta=Rd).
    r = rng.gamma(shape=2.0, scale=r_scale, size=n)
    phi = rng.uniform(0.0, 2.0 * np.pi, size=n)
    z = rng.exponential(scale=z_scale, size=n)
    z *= rng.choice(np.array([-1.0, 1.0]), size=n)

    x = r * np.cos(phi)
    y = r * np.sin(phi)
    return x, y, z, r, phi


def sample_hernquist_like(n, scale_radius, r_max, rng):
    # Inverse-transform sample for spherical profile p(r) ~ r^2 / (r+a)^3.
    u = rng.uniform(0.0, 1.0, size=n)
    sqrt_u = np.sqrt(u)
    r = scale_radius * sqrt_u / np.maximum(1.0 - sqrt_u, 1e-6)
    r = np.clip(r, 0.0, r_max)

    cos_t = rng.uniform(-1.0, 1.0, size=n)
    sin_t = np.sqrt(np.maximum(0.0, 1.0 - cos_t * cos_t))
    phi = rng.uniform(0.0, 2.0 * np.pi, size=n)

    x = r * sin_t * np.cos(phi)
    y = r * sin_t * np.sin(phi)
    z = r * cos_t
    return x, y, z, r


def smooth_inner_taper_weight(r, taper_radius, taper_power):
    if taper_radius <= 0.0:
        return np.ones_like(r, dtype=np.float64)

    scaled = np.maximum(r, 0.0) / max(taper_radius, 1e-9)
    weight = 1.0 - np.exp(-np.power(scaled, max(taper_power, 1e-3)))
    return np.clip(weight, 0.0, 1.0)


def sample_tapered_exponential_disk(
    n_target,
    r_scale,
    z_scale,
    rng,
    taper_radius,
    taper_power,
    sink_radius,
):
    if n_target <= 0:
        return (
            np.zeros(0, dtype=np.float64),
            np.zeros(0, dtype=np.float64),
            np.zeros(0, dtype=np.float64),
            np.zeros(0, dtype=np.float64),
            np.zeros(0, dtype=np.float64),
        )

    x_parts = []
    y_parts = []
    z_parts = []
    r_parts = []
    phi_parts = []
    accepted = 0

    while accepted < n_target:
        need = n_target - accepted
        draw = max(2048, int(np.ceil(need * 2.2)))
        x, y, z, r, phi = sample_exponential_disk(draw, r_scale=r_scale, z_scale=z_scale, rng=rng)

        keep_prob = smooth_inner_taper_weight(r, taper_radius=taper_radius, taper_power=taper_power)
        keep = rng.uniform(0.0, 1.0, size=draw) < keep_prob
        if sink_radius > 0.0:
            keep &= r >= sink_radius

        if not np.any(keep):
            continue

        xk = x[keep]
        yk = y[keep]
        zk = z[keep]
        rk = r[keep]
        phik = phi[keep]

        take = min(len(rk), need)
        x_parts.append(xk[:take])
        y_parts.append(yk[:take])
        z_parts.append(zk[:take])
        r_parts.append(rk[:take])
        phi_parts.append(phik[:take])
        accepted += take

    return (
        np.concatenate(x_parts),
        np.concatenate(y_parts),
        np.concatenate(z_parts),
        np.concatenate(r_parts),
        np.concatenate(phi_parts),
    )


def sample_tapered_hernquist_like(
    n_target,
    scale_radius,
    r_max,
    rng,
    taper_radius,
    taper_power,
    sink_radius,
):
    if n_target <= 0:
        return (
            np.zeros(0, dtype=np.float64),
            np.zeros(0, dtype=np.float64),
            np.zeros(0, dtype=np.float64),
            np.zeros(0, dtype=np.float64),
        )

    x_parts = []
    y_parts = []
    z_parts = []
    r_parts = []
    accepted = 0

    while accepted < n_target:
        need = n_target - accepted
        draw = max(2048, int(np.ceil(need * 2.2)))
        x, y, z, r = sample_hernquist_like(draw, scale_radius=scale_radius, r_max=r_max, rng=rng)

        keep_prob = smooth_inner_taper_weight(r, taper_radius=taper_radius, taper_power=taper_power)
        keep = rng.uniform(0.0, 1.0, size=draw) < keep_prob
        if sink_radius > 0.0:
            keep &= r >= sink_radius

        if not np.any(keep):
            continue

        xk = x[keep]
        yk = y[keep]
        zk = z[keep]
        rk = r[keep]

        take = min(len(rk), need)
        x_parts.append(xk[:take])
        y_parts.append(yk[:take])
        z_parts.append(zk[:take])
        r_parts.append(rk[:take])
        accepted += take

    return (
        np.concatenate(x_parts),
        np.concatenate(y_parts),
        np.concatenate(z_parts),
        np.concatenate(r_parts),
    )


def wrap_angle(angle):
    return np.arctan2(np.sin(angle), np.cos(angle))


def apply_log_spiral_to_disk(
    x,
    y,
    z,
    r,
    phi,
    rng,
    arm_count,
    arm_pitch_deg,
    arm_strength,
    arm_width,
    arm_inner_radius,
    arm_outer_radius,
):
    if len(r) == 0 or arm_strength <= 0.0:
        return x, y, z, r, phi

    arm_count = max(1, int(arm_count))
    pitch = np.deg2rad(np.clip(arm_pitch_deg, 5.0, 35.0))
    width = np.clip(arm_width, 0.2, 1.2)
    strength = np.clip(arm_strength, 0.0, 1.0)

    r_ref = max(arm_inner_radius, 1.0)
    # Use a trailing-arm winding (for positive v_phi rotation) so differential
    # shear reinforces the pattern instead of immediately winding it up.
    spiral_phase = arm_count * (phi + np.log(np.maximum(r, r_ref) / r_ref) / np.tan(pitch))
    phase_error = wrap_angle(spiral_phase)

    # Radius profile keeps arms weak in the inner disk, strongest at mid radii,
    # then smoothly fades them in the far outskirts.
    inner_suppress = 1.0 - np.exp(-np.square(r / np.maximum(1.2 * arm_inner_radius, 1e-6)))
    r_mid = 0.56 * arm_outer_radius
    sigma_mid = np.maximum(0.27 * arm_outer_radius, 1e-6)
    mid_peak = np.exp(-0.5 * np.square((r - r_mid) / sigma_mid))
    outer_fade = 1.0 / (1.0 + np.power(r / np.maximum(arm_outer_radius, 1e-6), 2.6))
    envelope = np.clip(inner_suppress * (0.35 + 0.95 * mid_peak) * outer_fade, 0.0, 1.0)

    coherence = np.exp(-0.5 * (phase_error / width) ** 2)
    phi_shift = -(strength / arm_count) * phase_error * coherence * envelope
    phi_shift += rng.normal(0.0, 0.010, size=r.size) * envelope

    # Small inward crowding at arm ridges helps keep arms visually crisp.
    radial_compress = 1.0 - 0.08 * strength * coherence * envelope
    r_new = np.maximum(r * radial_compress, 1e-3)
    phi_new = phi + phi_shift

    x_new = r_new * np.cos(phi_new)
    y_new = r_new * np.sin(phi_new)
    return x_new, y_new, z, r_new, phi_new


def circular_velocity_from_potential(potential, r):
    xyz = np.column_stack((r, np.zeros_like(r), np.zeros_like(r)))
    acc = potential.force(xyz)[:, 0]
    return np.sqrt(np.maximum(0.0, -r * acc))


def circular_velocity_from_softened_point_mass(mass, r, softening_sq):
    r2 = np.maximum(r * r, 1e-12)
    denom = np.power(r2 + softening_sq, 1.5)
    return np.sqrt(np.maximum(0.0, mass * r2 / denom))


def softened_point_mass_force(mass, positions, softening_sq):
    if mass <= 0.0 or len(positions) == 0:
        return np.zeros_like(positions, dtype=np.float64)

    r2 = np.sum(positions * positions, axis=1)
    denom = np.power(r2 + softening_sq, 1.5)
    return -(mass * positions) / np.maximum(denom[:, None], 1e-12)


def circular_velocity_total(potential, r, smbh_mass):
    v_c = circular_velocity_from_potential(potential, r)
    if smbh_mass > 0.0:
        v_c_smbh = circular_velocity_from_softened_point_mass(
            smbh_mass,
            r,
            BACKEND_SOFTENING_SQ,
        )
        v_c = np.sqrt(v_c * v_c + v_c_smbh * v_c_smbh)
    return v_c


def sample_satellite_clusters(
    n_particles,
    cluster_count,
    potential,
    smbh_mass,
    disk_scale_radius,
    taper_radius,
    sink_radius,
    cluster_spread,
    disk_scale_height,
    rng,
):
    if n_particles <= 0 or cluster_count <= 0:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.float64)

    cluster_count = max(1, int(cluster_count))
    counts = np.full(cluster_count, n_particles // cluster_count, dtype=np.int64)
    counts[: n_particles % cluster_count] += 1

    min_center_radius = max(1.25 * disk_scale_radius, 1.7 * taper_radius, 2.1 * sink_radius)
    max_center_radius = 3.8 * disk_scale_radius

    pos_parts = []
    vel_parts = []

    stream_clusters = min(2, cluster_count)

    for cluster_idx, n_star in enumerate(counts):
        if n_star <= 0:
            continue

        is_stream = cluster_idx < stream_clusters
        r_center = rng.uniform(min_center_radius, max_center_radius)
        phi_center = rng.uniform(0.0, 2.0 * np.pi)

        if is_stream:
            t = rng.uniform(-0.5, 0.5, size=int(n_star))
            arc_span = rng.uniform(0.35, 0.85)
            phi = phi_center + arc_span * t + rng.normal(0.0, 0.02, size=int(n_star))
            radius = r_center * (1.0 + 0.07 * t) + rng.normal(0.0, 0.025 * r_center, size=int(n_star))
            radius = np.maximum(radius, 1.05 * max(sink_radius, 1e-6))

            z_base = rng.normal(0.0, 1.6 * disk_scale_height, size=int(n_star))
            z_wave = 0.45 * disk_scale_height * np.sin(2.0 * np.pi * (t + 0.5))
            z = z_base + z_wave

            stars = np.column_stack((radius * np.cos(phi), radius * np.sin(phi), z))
        else:
            z_center = rng.normal(0.0, 0.09 * disk_scale_radius)
            center = np.array(
                [
                    r_center * np.cos(phi_center),
                    r_center * np.sin(phi_center),
                    z_center,
                ],
                dtype=np.float64,
            )
            spread = cluster_spread * rng.uniform(0.75, 1.5)
            stars = center[None, :] + rng.normal(0.0, spread, size=(int(n_star), 3))

        star_r = np.linalg.norm(stars, axis=1)
        min_star_radius = max(1.15 * sink_radius, 1.05 * taper_radius)
        too_inner = star_r < min_star_radius
        if np.any(too_inner):
            star_r_safe = np.maximum(star_r, 1e-9)
            radial_hat = stars / star_r_safe[:, None]
            random_fix = rng.normal(0.0, 1.0, size=stars.shape)
            random_fix /= np.maximum(np.linalg.norm(random_fix, axis=1, keepdims=True), 1e-12)
            radial_hat[too_inner & (star_r < 1e-9)] = random_fix[too_inner & (star_r < 1e-9)]
            stars[too_inner] = radial_hat[too_inner] * min_star_radius

        star_radius = np.linalg.norm(stars, axis=1)
        v_c = circular_velocity_total(
            potential,
            np.maximum(star_radius, 1e-6),
            smbh_mass,
        )

        xy_norm = np.linalg.norm(stars[:, :2], axis=1)
        xy_safe = np.maximum(xy_norm, 1e-9)
        tangential_hat = np.column_stack((-stars[:, 1] / xy_safe, stars[:, 0] / xy_safe, np.zeros_like(xy_safe)))
        radial_hat = np.column_stack((stars[:, 0] / xy_safe, stars[:, 1] / xy_safe, np.zeros_like(xy_safe)))

        if is_stream:
            stream_phase = rng.uniform(-1.0, 1.0, size=int(n_star))
            v_t = 0.97 * v_c + 0.05 * v_c * stream_phase + rng.normal(0.0, 0.03 * v_c, size=int(n_star))
            v_r = rng.normal(0.0, 0.015 * v_c, size=int(n_star))
            v_z = rng.normal(0.0, 0.020 * v_c, size=int(n_star))
        else:
            v_t = 0.97 * v_c + rng.normal(0.0, 0.04 * v_c, size=int(n_star))
            v_r = rng.normal(0.0, 0.020 * v_c, size=int(n_star))
            v_z = rng.normal(0.0, 0.025 * v_c, size=int(n_star))

        star_vel = tangential_hat * v_t[:, None] + radial_hat * v_r[:, None]
        star_vel[:, 2] += v_z

        pos_parts.append(stars)
        vel_parts.append(star_vel)

    if not pos_parts:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.float64)

    return np.vstack(pos_parts), np.vstack(vel_parts)


def apply_outer_disk_warp_and_flare(
    z,
    r,
    phi,
    disk_scale_radius,
    disk_scale_height,
    warp_start_factor,
    warp_strength,
    flare_strength,
):
    start_radius = max(warp_start_factor, 0.0) * disk_scale_radius
    end_radius = 5.0 * disk_scale_radius
    if end_radius <= start_radius + 1e-6:
        return z

    u = np.clip((r - start_radius) / (end_radius - start_radius), 0.0, 1.0)
    smooth_u = u * u * (3.0 - 2.0 * u)

    flare = 1.0 + np.clip(flare_strength, 0.0, 1.5) * smooth_u * smooth_u
    z_out = z * flare

    warp_amp = np.clip(warp_strength, 0.0, 1.5) * disk_scale_height
    radius_boost = np.minimum(r / np.maximum(disk_scale_radius, 1e-6), 4.0)
    z_out += warp_amp * smooth_u * radius_boost * np.sin(phi)

    return z_out


def _bootstrap_component_replacements(
    positions,
    velocities,
    masses,
    component_ids,
    component_id,
    n_needed,
    sink_radius,
    rng,
):
    if n_needed <= 0:
        return (
            np.zeros((0, 3), dtype=np.float64),
            np.zeros((0, 3), dtype=np.float64),
            np.zeros(0, dtype=np.float64),
            np.zeros(0, dtype=np.int8),
        )

    comp_idx = np.where(component_ids == component_id)[0]
    if len(comp_idx) == 0:
        comp_idx = np.arange(len(component_ids), dtype=np.int64)
    if len(comp_idx) == 0:
        return (
            np.zeros((0, 3), dtype=np.float64),
            np.zeros((0, 3), dtype=np.float64),
            np.zeros(0, dtype=np.float64),
            np.zeros(0, dtype=np.int8),
        )

    pick = rng.choice(comp_idx, size=n_needed, replace=True)
    pos = np.array(positions[pick], dtype=np.float64, copy=True)
    vel = np.array(velocities[pick], dtype=np.float64, copy=True)
    mass = np.array(masses[pick], dtype=np.float64, copy=True)

    src_r = np.linalg.norm(positions[comp_idx], axis=1)
    src_v = np.linalg.norm(velocities[comp_idx], axis=1)
    r_med = max(float(np.median(src_r)), 1.0)
    v_med = max(float(np.median(src_v)), 1e-4)

    pos += rng.normal(0.0, 0.018 * r_med, size=pos.shape)
    vel += rng.normal(0.0, 0.045 * v_med, size=vel.shape)

    rr = np.linalg.norm(pos, axis=1)
    min_r = 1.05 * max(sink_radius, 0.0)
    too_inner = rr < min_r
    if np.any(too_inner):
        rr_safe = np.maximum(rr, 1e-9)
        radial_hat = pos / rr_safe[:, None]
        random_hat = rng.normal(0.0, 1.0, size=pos.shape)
        random_hat /= np.maximum(np.linalg.norm(random_hat, axis=1, keepdims=True), 1e-12)
        radial_hat[too_inner & (rr < 1e-9)] = random_hat[too_inner & (rr < 1e-9)]
        pos[too_inner] = radial_hat[too_inner] * min_r

        v_r = np.sum(vel[too_inner] * radial_hat[too_inner], axis=1)
        inward = np.minimum(v_r, 0.0)
        vel[too_inner] -= radial_hat[too_inner] * inward[:, None]

    ids = np.full(n_needed, component_id, dtype=np.int8)
    return pos, vel, mass, ids


def sample_bound_orbital_velocities(
    x,
    y,
    z,
    potential,
    smbh_mass,
    rng,
    tangential_support,
    tangential_scatter,
    radial_scatter,
):
    pos = np.column_stack((x, y, z)).astype(np.float64, copy=False)
    r = np.linalg.norm(pos, axis=1)
    r_safe = np.maximum(r, 1e-6)

    radial_hat = pos / r_safe[:, None]
    random_vec = rng.normal(0.0, 1.0, size=pos.shape)
    tangent = random_vec - radial_hat * np.sum(random_vec * radial_hat, axis=1, keepdims=True)
    tangent_norm = np.linalg.norm(tangent, axis=1)

    fallback = np.cross(radial_hat, np.array([0.0, 0.0, 1.0], dtype=np.float64))
    fallback_norm = np.linalg.norm(fallback, axis=1)
    second_fallback = np.cross(radial_hat, np.array([0.0, 1.0, 0.0], dtype=np.float64))
    second_fallback_norm = np.linalg.norm(second_fallback, axis=1)

    bad = tangent_norm < 1e-10
    tangent[bad] = fallback[bad]
    tangent_norm[bad] = fallback_norm[bad]

    still_bad = tangent_norm < 1e-10
    tangent[still_bad] = second_fallback[still_bad]
    tangent_norm[still_bad] = second_fallback_norm[still_bad]

    tangent = tangent / np.maximum(tangent_norm[:, None], 1e-12)

    v_c = circular_velocity_total(potential, r_safe, smbh_mass)
    v_t = tangential_support * v_c + rng.normal(0.0, tangential_scatter * v_c, size=r.size)
    v_r = rng.normal(0.0, radial_scatter * v_c, size=r.size)

    vel = tangent * v_t[:, None] + radial_hat * v_r[:, None]

    speed = np.linalg.norm(vel, axis=1)
    # Keep particles bound with a conservative cap under local escape estimate.
    v_cap = 0.92 * np.sqrt(2.0) * np.maximum(v_c, 1e-6)
    scale = np.minimum(1.0, v_cap / np.maximum(speed, 1e-12))
    vel *= scale[:, None]

    return vel[:, 0], vel[:, 1], vel[:, 2]


def recenter_phase_space(positions, velocities, masses):
    weights = np.asarray(masses, dtype=np.float64)
    total_mass = float(np.sum(weights))
    if total_mass <= 0.0:
        raise ValueError("snapshot mass must be positive")

    centered_positions = np.asarray(positions, dtype=np.float64) - np.average(
        positions,
        axis=0,
        weights=weights,
    )
    centered_velocities = np.asarray(velocities, dtype=np.float64) - np.average(
        velocities,
        axis=0,
        weights=weights,
    )
    return centered_positions, centered_velocities


def _generate_stable_baseline_snapshot(
    num_particles,
    seed,
    smbh_mass,
    smbh_exclusion_radius,
):
    rng = np.random.default_rng(seed)

    if num_particles < 1:
        raise ValueError("num_particles must be >= 1")

    agama.setUnits(length=1, velocity=1, mass=1)

    disk_mass = 22000.0
    bulge_mass = 4500.0
    halo_mass = 28000.0

    disk_rd = 65.0 * GALAXY_SCALE
    disk_zh = 3.2 * GALAXY_SCALE
    bulge_a = 18.0 * GALAXY_SCALE
    halo_rs = 220.0 * GALAXY_SCALE
    bulge_cutoff = 140.0 * GALAXY_SCALE
    halo_rmax = 850.0 * GALAXY_SCALE

    potential = agama.Potential(
        agama.Potential(type="MiyamotoNagai", mass=disk_mass, scaleRadius=disk_rd, scaleHeight=disk_zh),
        agama.Potential(type="Spheroid", mass=bulge_mass, scaleRadius=bulge_a, outerCutoffRadius=bulge_cutoff),
        agama.Potential(type="NFW", mass=halo_mass, scaleRadius=halo_rs),
    )

    has_smbh = smbh_mass > 0.0
    sampled_particles = num_particles - 1 if has_smbh else num_particles
    if sampled_particles < 1:
        raise ValueError("num_particles must be >= 2 when smbh_mass > 0")

    n_disk, n_bulge, n_halo = component_counts(sampled_particles, fractions=(0.87, 0.08, 0.05))

    xd, yd, zd, rd, phid = sample_exponential_disk(n_disk, r_scale=disk_rd, z_scale=disk_zh, rng=rng)
    xb, yb, zb, rb = sample_hernquist_like(n_bulge, scale_radius=bulge_a, r_max=bulge_cutoff, rng=rng)
    xh, yh, zh, rh = sample_hernquist_like(n_halo, scale_radius=halo_rs, r_max=halo_rmax, rng=rng)

    if has_smbh and smbh_exclusion_radius > 0.0:
        rd = np.maximum(rd, smbh_exclusion_radius)
        xd = rd * np.cos(phid)
        yd = rd * np.sin(phid)

        rb = np.maximum(rb, smbh_exclusion_radius)
        bulge_norm = np.sqrt(np.maximum(xb * xb + yb * yb + zb * zb, 1e-12))
        xb = xb / bulge_norm * rb
        yb = yb / bulge_norm * rb
        zb = zb / bulge_norm * rb

        rh = np.maximum(rh, smbh_exclusion_radius)
        halo_norm = np.sqrt(np.maximum(xh * xh + yh * yh + zh * zh, 1e-12))
        xh = xh / halo_norm * rh
        yh = yh / halo_norm * rh
        zh = zh / halo_norm * rh

    rd_safe = np.maximum(rd, 4.0 * GALAXY_SCALE)
    v_c = circular_velocity_total(potential, rd_safe, smbh_mass if has_smbh else 0.0)
    sigma_r = 0.085 * np.exp(-rd_safe / (180.0 * GALAXY_SCALE)) + 0.020
    sigma_z = 0.060 * np.exp(-rd_safe / (180.0 * GALAXY_SCALE)) + 0.015
    sigma_phi = 0.70 * sigma_r

    v_phi = 0.995 * v_c + rng.normal(0.0, sigma_phi, size=n_disk)
    v_r = rng.normal(0.0, sigma_r, size=n_disk)
    v_z = rng.normal(0.0, sigma_z, size=n_disk)

    cos_p = np.cos(phid)
    sin_p = np.sin(phid)
    vxd = v_r * cos_p - v_phi * sin_p
    vyd = v_r * sin_p + v_phi * cos_p
    vzd = v_z

    vxb, vyb, vzb = sample_bound_orbital_velocities(
        xb,
        yb,
        zb,
        potential=potential,
        smbh_mass=smbh_mass if has_smbh else 0.0,
        rng=rng,
        tangential_support=0.96,
        tangential_scatter=0.06,
        radial_scatter=0.05,
    )

    vxh, vyh, vzh = sample_bound_orbital_velocities(
        xh,
        yh,
        zh,
        potential=potential,
        smbh_mass=smbh_mass if has_smbh else 0.0,
        rng=rng,
        tangential_support=0.88,
        tangential_scatter=0.10,
        radial_scatter=0.08,
    )

    positions = np.vstack(
        [
            np.column_stack((xd, yd, zd)),
            np.column_stack((xb, yb, zb)),
            np.column_stack((xh, yh, zh)),
        ]
    ).astype(np.float64, copy=False)
    velocities = np.vstack(
        [
            np.column_stack((vxd, vyd, vzd)),
            np.column_stack((vxb, vyb, vzb)),
            np.column_stack((vxh, vyh, vzh)),
        ]
    ).astype(np.float64, copy=False)
    masses = np.concatenate(
        [
            np.full(n_disk, disk_mass / max(n_disk, 1), dtype=np.float64),
            np.full(n_bulge, bulge_mass / max(n_bulge, 1), dtype=np.float64),
            np.full(n_halo, halo_mass / max(n_halo, 1), dtype=np.float64),
        ]
    )

    positions, velocities = recenter_phase_space(positions, velocities, masses)

    if has_smbh:
        positions = np.vstack((np.array([[0.0, 0.0, 0.0]], dtype=np.float64), positions))
        velocities = np.vstack((np.array([[0.0, 0.0, 0.0]], dtype=np.float64), velocities))
        masses = np.concatenate((np.array([smbh_mass], dtype=np.float64), masses))

    forces = potential.force(positions).astype(np.float64, copy=False)
    if has_smbh:
        forces += softened_point_mass_force(smbh_mass, positions, BACKEND_SOFTENING_SQ)
        forces[0, :] = 0.0

    inner_r = np.linalg.norm(positions[1 if has_smbh else 0 :], axis=1)
    inner_min_r = float(np.min(inner_r)) if len(inner_r) else 0.0
    inside_exclusion = int(np.count_nonzero(inner_r < smbh_exclusion_radius))

    print("--- Galaxy Snapshot Generation Complete ---")
    print(f"Preset:           {PRESET_STABLE}")
    print(f"Particles total:  {num_particles}")
    print(f"Disk/Bulge/Halo:  {n_disk}/{n_bulge}/{n_halo}")
    print(f"SMBH mass:        {smbh_mass:.3f}")
    print(f"SMBH exclusion R: {smbh_exclusion_radius:.3f}")
    print(f"Galaxy scale:     {GALAXY_SCALE}x")
    print(f"Inner min R:      {inner_min_r:.3f}")
    print(f"Inside exclusion: {inside_exclusion}")
    print("Length unit:      toy (dimensionless)")
    print(f"Positions shape:  {positions.shape}")
    print(f"Velocities shape: {velocities.shape}")
    print(f"Masses shape:     {masses.shape}")
    print(f"Forces shape:     {forces.shape}")

    return (
        positions.astype(np.float32, copy=False),
        velocities.astype(np.float32, copy=False),
        masses.astype(np.float32, copy=False),
        forces.astype(np.float32, copy=False),
    )


def generate_milky_way_snapshot(
    num_particles=10000,
    seed=42,
    smbh_mass=DEFAULT_SMBH_MASS,
    smbh_exclusion_radius=DEFAULT_SMBH_EXCLUSION_RADIUS,
    smbh_taper_power=DEFAULT_SMBH_TAPER_POWER,
    smbh_sink_radius=DEFAULT_SMBH_SINK_RADIUS,
    arm_count=DEFAULT_ARM_COUNT,
    arm_pitch_deg=DEFAULT_ARM_PITCH_DEG,
    arm_strength=DEFAULT_ARM_STRENGTH,
    arm_width=DEFAULT_ARM_WIDTH,
    bulge_mass_scale=DEFAULT_BULGE_MASS_SCALE,
    bulge_compactness=DEFAULT_BULGE_COMPACTNESS,
    cluster_count=DEFAULT_CLUSTER_COUNT,
    cluster_particle_fraction=DEFAULT_CLUSTER_PARTICLE_FRACTION,
    cluster_mass_fraction=DEFAULT_CLUSTER_MASS_FRACTION,
    cluster_spread=DEFAULT_CLUSTER_SPREAD,
    warp_start_factor=DEFAULT_WARP_START_FACTOR,
    warp_strength=DEFAULT_WARP_STRENGTH,
    flare_strength=DEFAULT_FLARE_STRENGTH,
    preset=DEFAULT_PRESET,
):
    if preset not in PRESET_CHOICES:
        raise ValueError(f"preset must be one of {PRESET_CHOICES}")

    if preset == PRESET_STABLE:
        return _generate_stable_baseline_snapshot(
            num_particles=num_particles,
            seed=seed,
            smbh_mass=smbh_mass,
            smbh_exclusion_radius=smbh_exclusion_radius,
        )

    if preset == PRESET_CINEMATIC:
        arm_strength = max(arm_strength, 0.68)
        arm_width = min(arm_width, 0.48)
        bulge_mass_scale = max(bulge_mass_scale, 1.20)
        bulge_compactness = max(bulge_compactness, 1.35)
        cluster_count = max(int(cluster_count), 6)
        cluster_particle_fraction = max(cluster_particle_fraction, 0.040)
        cluster_mass_fraction = max(cluster_mass_fraction, 0.012)
        warp_strength = max(warp_strength, 0.34)
        flare_strength = max(flare_strength, 0.62)

    rng = np.random.default_rng(seed)

    if num_particles < 1:
        raise ValueError("num_particles must be >= 1")

    # Dimensionless toy units (matches backend G=1 setup).
    agama.setUnits(length=1, velocity=1, mass=1)

    # Keep a strong central SMBH while retaining a self-gravitating disk/halo.
    disk_mass = 22000.0
    bulge_mass = 4500.0 * np.clip(bulge_mass_scale, 0.55, 1.9)
    halo_mass = 28000.0

    bulge_compactness = np.clip(bulge_compactness, 0.60, 2.50)

    disk_rd = 65.0 * GALAXY_SCALE
    disk_zh = 3.2 * GALAXY_SCALE
    bulge_a = (18.0 * GALAXY_SCALE) / bulge_compactness
    halo_rs = 220.0 * GALAXY_SCALE
    bulge_cutoff = (140.0 * GALAXY_SCALE) / np.sqrt(bulge_compactness)
    halo_rmax = 850.0 * GALAXY_SCALE

    # Build a composite potential for force evaluation and circular speed curve.
    potential = agama.Potential(
        agama.Potential(type="MiyamotoNagai", mass=disk_mass, scaleRadius=disk_rd, scaleHeight=disk_zh),
        agama.Potential(type="Spheroid", mass=bulge_mass, scaleRadius=bulge_a, outerCutoffRadius=bulge_cutoff),
        agama.Potential(type="NFW", mass=halo_mass, scaleRadius=halo_rs),
    )

    # Reserve index 0 for an optional central SMBH so stars orbit around a dominant center.
    has_smbh = smbh_mass > 0.0
    sampled_particles = num_particles - 1 if has_smbh else num_particles
    if sampled_particles < 1:
        raise ValueError("num_particles must be >= 2 when smbh_mass > 0")

    # Allocate particles across components.
    cluster_particle_fraction = np.clip(cluster_particle_fraction, 0.0, 0.08)
    n_clusters = int(round(sampled_particles * cluster_particle_fraction))
    n_clusters = min(max(n_clusters, 0), max(0, sampled_particles - 300))

    sampled_main = sampled_particles - n_clusters
    if sampled_main < 1:
        raise ValueError("cluster_particle_fraction leaves no particles for primary components")

    n_disk, n_bulge, n_halo = component_counts(sampled_main, fractions=(0.87, 0.08, 0.05))

    # Smoothly taper inner density and apply a small sink radius during sampling
    # to avoid an artificial hard shell and ring pile-up near the SMBH.
    taper_radius = max(smbh_exclusion_radius, 0.0)
    sink_radius = max(smbh_sink_radius, 0.0)
    taper_power = max(smbh_taper_power, 1e-3)

    # Sample spatial distribution.
    xd, yd, zd, rd, phid = sample_tapered_exponential_disk(
        n_disk,
        r_scale=disk_rd,
        z_scale=disk_zh,
        rng=rng,
        taper_radius=taper_radius,
        taper_power=taper_power,
        sink_radius=sink_radius,
    )
    zd = apply_outer_disk_warp_and_flare(
        zd,
        rd,
        phid,
        disk_scale_radius=disk_rd,
        disk_scale_height=disk_zh,
        warp_start_factor=warp_start_factor,
        warp_strength=warp_strength,
        flare_strength=flare_strength,
    )
    xb, yb, zb, rb = sample_tapered_hernquist_like(
        n_bulge,
        scale_radius=bulge_a,
        r_max=bulge_cutoff,
        rng=rng,
        taper_radius=taper_radius,
        taper_power=taper_power,
        sink_radius=sink_radius,
    )
    xh, yh, zh, rh = sample_tapered_hernquist_like(
        n_halo,
        scale_radius=halo_rs,
        r_max=halo_rmax,
        rng=rng,
        taper_radius=taper_radius,
        taper_power=taper_power,
        sink_radius=sink_radius,
    )

    cluster_positions, cluster_velocities = sample_satellite_clusters(
        n_particles=n_clusters,
        cluster_count=max(0, int(cluster_count)),
        potential=potential,
        smbh_mass=smbh_mass if has_smbh else 0.0,
        disk_scale_radius=disk_rd,
        taper_radius=taper_radius,
        sink_radius=sink_radius,
        cluster_spread=max(cluster_spread, 0.5 * GALAXY_SCALE),
        disk_scale_height=disk_zh,
        rng=rng,
    )
    n_clusters = int(cluster_positions.shape[0])

    # Add explicit log-spiral arm crowding to keep arms crisp while preserving disk stability.
    arm_inner_radius = 0.55 * disk_rd
    arm_outer_radius = 4.8 * disk_rd
    xd, yd, zd, rd, phid = apply_log_spiral_to_disk(
        xd,
        yd,
        zd,
        rd,
        phid,
        rng=rng,
        arm_count=arm_count,
        arm_pitch_deg=arm_pitch_deg,
        arm_strength=arm_strength,
        arm_width=arm_width,
        arm_inner_radius=arm_inner_radius,
        arm_outer_radius=arm_outer_radius,
    )

    # Disk kinematics: colder near-circular rotation to maintain a defined disk for longer.
    rd_safe = np.maximum(rd, 4.0 * GALAXY_SCALE)
    v_c = circular_velocity_total(potential, rd_safe, smbh_mass if has_smbh else 0.0)
    sigma_r = 0.085 * np.exp(-rd_safe / (180.0 * GALAXY_SCALE)) + 0.020
    sigma_z = 0.060 * np.exp(-rd_safe / (180.0 * GALAXY_SCALE)) + 0.015
    sigma_phi = 0.70 * sigma_r

    spiral_phase = arm_count * (
        phid + np.log(np.maximum(rd_safe, max(arm_inner_radius, 1.0)) / max(arm_inner_radius, 1.0))
        / np.tan(np.deg2rad(np.clip(arm_pitch_deg, 5.0, 35.0)))
    )
    arm_gate = 1.0 / (1.0 + (rd_safe / np.maximum(arm_outer_radius, 1e-6)) ** 2)
    streaming_wave = 0.06 * np.clip(arm_strength, 0.0, 1.0) * v_c * np.sin(spiral_phase) * arm_gate

    v_phi = 0.995 * v_c + streaming_wave + rng.normal(0.0, sigma_phi, size=n_disk)
    v_r = rng.normal(0.0, sigma_r, size=n_disk)
    v_z = rng.normal(0.0, sigma_z, size=n_disk)

    cos_p = np.cos(phid)
    sin_p = np.sin(phid)
    vxd = v_r * cos_p - v_phi * sin_p
    vyd = v_r * sin_p + v_phi * cos_p
    vzd = v_z

    # Bulge/halo: orbitalized initialization to keep all bodies bound around the SMBH.
    vxb, vyb, vzb = sample_bound_orbital_velocities(
        xb,
        yb,
        zb,
        potential=potential,
        smbh_mass=smbh_mass if has_smbh else 0.0,
        rng=rng,
        tangential_support=0.96,
        tangential_scatter=0.06,
        radial_scatter=0.05,
    )

    vxh, vyh, vzh = sample_bound_orbital_velocities(
        xh,
        yh,
        zh,
        potential=potential,
        smbh_mass=smbh_mass if has_smbh else 0.0,
        rng=rng,
        tangential_support=0.88,
        tangential_scatter=0.10,
        radial_scatter=0.08,
    )

    cluster_mass_fraction = np.clip(cluster_mass_fraction, 0.0, 0.04)
    cluster_mass_total = (disk_mass + bulge_mass + halo_mass) * cluster_mass_fraction if n_clusters > 0 else 0.0
    cluster_mass_total = min(cluster_mass_total, 0.25 * halo_mass)
    halo_mass_particles = halo_mass - cluster_mass_total

    position_parts = [
        np.column_stack((xd, yd, zd)),
        np.column_stack((xb, yb, zb)),
        np.column_stack((xh, yh, zh)),
    ]
    velocity_parts = [
        np.column_stack((vxd, vyd, vzd)),
        np.column_stack((vxb, vyb, vzb)),
        np.column_stack((vxh, vyh, vzh)),
    ]

    if n_clusters > 0:
        position_parts.append(cluster_positions)
        velocity_parts.append(cluster_velocities)

    mass_parts = [
        np.full(n_disk, disk_mass / max(n_disk, 1), dtype=np.float64),
        np.full(n_bulge, bulge_mass / max(n_bulge, 1), dtype=np.float64),
        np.full(n_halo, halo_mass_particles / max(n_halo, 1), dtype=np.float64),
    ]

    if n_clusters > 0:
        mass_parts.append(np.full(n_clusters, cluster_mass_total / n_clusters, dtype=np.float64))

    positions = np.vstack(position_parts).astype(np.float64, copy=False)
    velocities = np.vstack(velocity_parts).astype(np.float64, copy=False)
    masses = np.concatenate(mass_parts).astype(np.float64, copy=False)
    component_ids = np.concatenate(
        [
            np.zeros(n_disk, dtype=np.int8),
            np.ones(n_bulge, dtype=np.int8),
            np.full(n_halo, 2, dtype=np.int8),
            np.full(n_clusters, 3, dtype=np.int8),
        ]
    )

    # Keep the system centered so all components orbit around the SMBH frame.
    positions, velocities = recenter_phase_space(positions, velocities, masses)

    if has_smbh:
        positions = np.vstack((np.array([[0.0, 0.0, 0.0]], dtype=np.float64), positions))
        velocities = np.vstack((np.array([[0.0, 0.0, 0.0]], dtype=np.float64), velocities))
        masses = np.concatenate((np.array([smbh_mass], dtype=np.float64), masses))

    accreted_count = 0
    accreted_mass = 0.0
    replenished_count = 0
    if has_smbh and sink_radius > 0.0 and len(positions) > 1:
        star_r = np.linalg.norm(positions[1:], axis=1)
        keep_mask = star_r >= sink_radius
        accreted_count = int(np.count_nonzero(~keep_mask))
        if accreted_count > 0:
            accreted_mass = float(np.sum(masses[1:][~keep_mask]))
            removed_components = component_ids[~keep_mask]

            positions = np.vstack((positions[:1], positions[1:][keep_mask]))
            velocities = np.vstack((velocities[:1], velocities[1:][keep_mask]))
            masses = np.concatenate((masses[:1], masses[1:][keep_mask]))
            component_ids = component_ids[keep_mask]

            for comp_id in np.unique(removed_components):
                need = int(np.count_nonzero(removed_components == comp_id))
                if need <= 0:
                    continue

                rep_pos, rep_vel, rep_mass, rep_ids = _bootstrap_component_replacements(
                    positions=positions[1:],
                    velocities=velocities[1:],
                    masses=masses[1:],
                    component_ids=component_ids,
                    component_id=int(comp_id),
                    n_needed=need,
                    sink_radius=sink_radius,
                    rng=rng,
                )
                if len(rep_pos) == 0:
                    continue

                positions = np.vstack((positions, rep_pos))
                velocities = np.vstack((velocities, rep_vel))
                masses = np.concatenate((masses, rep_mass))
                component_ids = np.concatenate((component_ids, rep_ids))
                replenished_count += len(rep_pos)

    if has_smbh and len(positions) < num_particles:
        # Safety top-up path to guarantee exact requested count.
        need = int(num_particles - len(positions))
        rep_pos, rep_vel, rep_mass, rep_ids = _bootstrap_component_replacements(
            positions=positions[1:],
            velocities=velocities[1:],
            masses=masses[1:],
            component_ids=component_ids,
            component_id=0,
            n_needed=need,
            sink_radius=sink_radius,
            rng=rng,
        )
        if len(rep_pos) > 0:
            positions = np.vstack((positions, rep_pos))
            velocities = np.vstack((velocities, rep_vel))
            masses = np.concatenate((masses, rep_mass))
            component_ids = np.concatenate((component_ids, rep_ids))
            replenished_count += len(rep_pos)

    forces = potential.force(positions).astype(np.float64, copy=False)
    if has_smbh:
        forces += softened_point_mass_force(smbh_mass, positions, BACKEND_SOFTENING_SQ)
        forces[0, :] = 0.0

    inner_r = np.linalg.norm(positions[1 if has_smbh else 0 :], axis=1)
    inner_min_r = float(np.min(inner_r)) if len(inner_r) else 0.0
    inside_taper_radius = int(np.count_nonzero(inner_r < taper_radius))
    inside_sink_radius = int(np.count_nonzero(inner_r < sink_radius))

    print("--- Galaxy Snapshot Generation Complete ---")
    print(f"Preset:           {preset}")
    print(f"Particles total:  {num_particles}")
    print(f"Disk/Bulge/Halo/Clusters:  {n_disk}/{n_bulge}/{n_halo}/{n_clusters}")
    print(f"SMBH mass:        {smbh_mass:.3f}")
    print(f"SMBH taper R:     {taper_radius:.3f}")
    print(f"SMBH taper pow:   {taper_power:.3f}")
    print(f"SMBH sink R:      {sink_radius:.3f}")
    print(f"Init accreted N:  {accreted_count}")
    print(f"Init accreted M:  {accreted_mass:.3f}")
    print(f"Replenished N:    {replenished_count}")
    print(f"Arm count:        {max(1, int(arm_count))}")
    print(f"Arm pitch (deg):  {arm_pitch_deg:.2f}")
    print(f"Arm strength:     {arm_strength:.2f}")
    print(f"Arm width:        {arm_width:.2f}")
    print(f"Warp start (Rd):  {warp_start_factor:.2f}")
    print(f"Warp strength:    {warp_strength:.3f}")
    print(f"Flare strength:   {flare_strength:.3f}")
    print(f"Bulge mass scale: {bulge_mass_scale:.3f}")
    print(f"Bulge compactness:{bulge_compactness:.3f}")
    print(f"Cluster count:    {max(0, int(cluster_count))}")
    print(f"Cluster p-frac:   {cluster_particle_fraction:.4f}")
    print(f"Cluster m-frac:   {cluster_mass_fraction:.4f}")
    print(f"Cluster spread:   {cluster_spread:.3f}")
    print(f"Galaxy scale:     {GALAXY_SCALE}x")
    print(f"Inner min R:      {inner_min_r:.3f}")
    print(f"Inside taper R:   {inside_taper_radius}")
    print(f"Inside sink R:    {inside_sink_radius}")
    print("Length unit:      toy (dimensionless)")
    print(f"Positions shape:  {positions.shape}")
    print(f"Velocities shape: {velocities.shape}")
    print(f"Masses shape:     {masses.shape}")
    print(f"Forces shape:     {forces.shape}")

    return (
        positions.astype(np.float32, copy=False),
        velocities.astype(np.float32, copy=False),
        masses.astype(np.float32, copy=False),
        forces.astype(np.float32, copy=False),
    )


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate a stable spiral-galaxy AGAMA snapshot (10k-30k friendly)"
    )
    parser.add_argument(
        "--preset",
        type=str,
        choices=PRESET_CHOICES,
        default=DEFAULT_PRESET,
        help="generation preset; stable uses baseline with no added spiral/warp/cluster/taper/sink features",
    )
    parser.add_argument("--n", type=int, default=10000, help="number of bodies")
    parser.add_argument("--seed", type=int, default=42, help="random seed")
    parser.add_argument(
        "--smbh-mass",
        type=float,
        default=DEFAULT_SMBH_MASS,
        help="central supermassive black hole mass in toy units (set 0 to disable)",
    )
    parser.add_argument(
        "--smbh-exclusion-radius",
        type=float,
        default=DEFAULT_SMBH_EXCLUSION_RADIUS,
        help="smooth inner taper radius around SMBH (not a hard cutoff)",
    )
    parser.add_argument(
        "--smbh-taper-power",
        type=float,
        default=DEFAULT_SMBH_TAPER_POWER,
        help="power for smooth inner taper; higher means steeper central suppression",
    )
    parser.add_argument(
        "--smbh-sink-radius",
        type=float,
        default=DEFAULT_SMBH_SINK_RADIUS,
        help="generator sink radius; samples inside this are discarded and resampled",
    )
    parser.add_argument(
        "--arm-count",
        type=int,
        default=DEFAULT_ARM_COUNT,
        help="number of logarithmic spiral arms",
    )
    parser.add_argument(
        "--arm-pitch-deg",
        type=float,
        default=DEFAULT_ARM_PITCH_DEG,
        help="log-spiral pitch angle in degrees",
    )
    parser.add_argument(
        "--arm-strength",
        type=float,
        default=DEFAULT_ARM_STRENGTH,
        help="spiral arm crowding strength (0..1)",
    )
    parser.add_argument(
        "--arm-width",
        type=float,
        default=DEFAULT_ARM_WIDTH,
        help="spiral arm angular width in phase space",
    )
    parser.add_argument(
        "--bulge-mass-scale",
        type=float,
        default=DEFAULT_BULGE_MASS_SCALE,
        help="scale factor for bulge mass",
    )
    parser.add_argument(
        "--bulge-compactness",
        type=float,
        default=DEFAULT_BULGE_COMPACTNESS,
        help="bulge concentration factor (>1 is more compact)",
    )
    parser.add_argument(
        "--cluster-count",
        type=int,
        default=DEFAULT_CLUSTER_COUNT,
        help="number of nearby orbiting stellar clusters",
    )
    parser.add_argument(
        "--cluster-particle-fraction",
        type=float,
        default=DEFAULT_CLUSTER_PARTICLE_FRACTION,
        help="fraction of particles allocated to clusters",
    )
    parser.add_argument(
        "--cluster-mass-fraction",
        type=float,
        default=DEFAULT_CLUSTER_MASS_FRACTION,
        help="fraction of total component mass allocated to clusters",
    )
    parser.add_argument(
        "--cluster-spread",
        type=float,
        default=DEFAULT_CLUSTER_SPREAD,
        help="typical cluster size (position spread)",
    )
    parser.add_argument(
        "--warp-start-factor",
        type=float,
        default=DEFAULT_WARP_START_FACTOR,
        help="outer warp start radius as a multiple of disk scale radius",
    )
    parser.add_argument(
        "--warp-strength",
        type=float,
        default=DEFAULT_WARP_STRENGTH,
        help="amplitude of outer S-shaped disk warp",
    )
    parser.add_argument(
        "--flare-strength",
        type=float,
        default=DEFAULT_FLARE_STRENGTH,
        help="outer disk vertical flare strength",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=str(Path(__file__).resolve().parent.parent / "galaxy_30k.bin"),
        help="output binary snapshot path",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    pos, vel, mass, frc = generate_milky_way_snapshot(
        preset=args.preset,
        num_particles=args.n,
        seed=args.seed,
        smbh_mass=args.smbh_mass,
        smbh_exclusion_radius=args.smbh_exclusion_radius,
        smbh_taper_power=args.smbh_taper_power,
        smbh_sink_radius=args.smbh_sink_radius,
        arm_count=args.arm_count,
        arm_pitch_deg=args.arm_pitch_deg,
        arm_strength=args.arm_strength,
        arm_width=args.arm_width,
        bulge_mass_scale=args.bulge_mass_scale,
        bulge_compactness=args.bulge_compactness,
        cluster_count=args.cluster_count,
        cluster_particle_fraction=args.cluster_particle_fraction,
        cluster_mass_fraction=args.cluster_mass_fraction,
        cluster_spread=args.cluster_spread,
        warp_start_factor=args.warp_start_factor,
        warp_strength=args.warp_strength,
        flare_strength=args.flare_strength,
    )
    write_agama_binary_snapshot(
        output_path=args.out,
        positions=pos,
        velocities=vel,
        masses=mass,
        forces=frc,
    )


# run this in the WSL terminal first:
# source /mnt/c/Users/Pranav/Code/repos/Agama/.venv/bin/activate

# example run command:
# python3 generateGalaxy.py --preset cinematic --n 30000 --seed 42