import argparse
from pathlib import Path

import agama
import numpy as np


GALAXY_SCALE = 25.0
# Pick the AGAMA mass unit so that the internal gravitational constant becomes G=1,
# matching the backend's toy-unit integrator.
AGAMA_G1_MASS_UNIT = 1.0 / 4.30091727067736e-06

DEFAULT_SMBH_MASS = 250.0
BACKEND_SOFTENING_SQ = 0.1
DEFAULT_SMBH_EXCLUSION_RADIUS = 6.0 * GALAXY_SCALE

THIN_DISK_FRACTION = 0.56
THICK_DISK_FRACTION = 0.16
BAR_FRACTION = 0.18
HALO_FRACTION = 0.10

THIN_DISK_MASS = 28000.0
THICK_DISK_MASS = 9000.0
BAR_MASS = 11000.0
HALO_MASS = 12000.0

THIN_DISK_SCALE_RADIUS = 75.0 * GALAXY_SCALE
THIN_DISK_SCALE_HEIGHT = 4.5 * GALAXY_SCALE
THICK_DISK_SCALE_RADIUS = 58.0 * GALAXY_SCALE
THICK_DISK_SCALE_HEIGHT = 11.0 * GALAXY_SCALE

BAR_HALF_LENGTH = 28.0 * GALAXY_SCALE
BAR_AXIS_RATIO_Y = 0.43
BAR_AXIS_RATIO_Z = 0.24
BAR_CUTOFF_RADIUS = 46.0 * GALAXY_SCALE

POTENTIAL_BULGE_SCALE_RADIUS = 24.0 * GALAXY_SCALE
POTENTIAL_BULGE_CUTOFF_RADIUS = 70.0 * GALAXY_SCALE
HALO_SCALE_RADIUS = 220.0 * GALAXY_SCALE
HALO_CUTOFF_RADIUS = 650.0 * GALAXY_SCALE

DEFAULT_BAR_ANGLE_DEG = 28.0
DEFAULT_ARM_PITCH_DEG = 13.5
DEFAULT_ARM_STRENGTH = 0.55
DEFAULT_ARM_COUNT = 2
MAX_SAMPLE_RADIUS = 12.0 * HALO_SCALE_RADIUS
MAX_SAMPLE_SPEED = 64.0


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


def sigma0_from_disk_mass(total_mass, scale_radius):
    return total_mass / (2.0 * np.pi * scale_radius * scale_radius)


def wrap_angle(angle):
    return np.arctan2(np.sin(angle), np.cos(angle))


def rotate_xy(array, angle_rad):
    result = np.array(array, dtype=np.float64, copy=True)
    if result.size == 0:
        return result

    c = np.cos(angle_rad)
    s = np.sin(angle_rad)
    x = result[:, 0].copy()
    y = result[:, 1].copy()
    result[:, 0] = x * c - y * s
    result[:, 1] = x * s + y * c
    return result


def circular_velocity_from_potential(potential, radius):
    xyz = np.column_stack((radius, np.zeros_like(radius), np.zeros_like(radius)))
    acc = potential.force(xyz)[:, 0]
    return np.sqrt(np.maximum(0.0, -radius * acc))


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


def enforce_minimum_radius(xv, min_radius, rng):
    if min_radius <= 0.0 or len(xv) == 0:
        return xv

    pos = np.array(xv[:, :3], dtype=np.float64, copy=True)
    vel = np.array(xv[:, 3:], dtype=np.float64, copy=True)
    radius = np.linalg.norm(pos, axis=1)
    mask = radius < min_radius
    if not np.any(mask):
        return np.column_stack((pos, vel))

    direction = np.zeros_like(pos)
    safe_radius = np.maximum(radius, 1e-12)
    direction[:] = pos / safe_radius[:, None]

    zero_mask = mask & (radius < 1e-12)
    if np.any(zero_mask):
        random_dir = rng.normal(0.0, 1.0, size=(np.sum(zero_mask), 3))
        random_dir /= np.linalg.norm(random_dir, axis=1)[:, None]
        direction[zero_mask] = random_dir

    pos[mask] = direction[mask] * min_radius
    return np.column_stack((pos, vel))


def apply_spiral_arms(xv, rng, bar_angle_deg, arm_pitch_deg, arm_strength, arm_count=DEFAULT_ARM_COUNT):
    if len(xv) == 0 or arm_strength <= 0.0:
        return xv

    pos = np.array(xv[:, :3], dtype=np.float64, copy=True)
    vel = np.array(xv[:, 3:], dtype=np.float64, copy=True)

    x = pos[:, 0]
    y = pos[:, 1]
    z = pos[:, 2]
    vx = vel[:, 0]
    vy = vel[:, 1]
    vz = vel[:, 2]

    radius_xy = np.sqrt(x * x + y * y)
    radius_xy_safe = np.maximum(radius_xy, 1e-9)
    phi = np.arctan2(y, x)

    v_r = (x * vx + y * vy) / radius_xy_safe
    v_phi = (-y * vx + x * vy) / radius_xy_safe

    pitch = np.deg2rad(arm_pitch_deg)
    bar_angle = np.deg2rad(bar_angle_deg)

    arm_start = 1.1 * BAR_HALF_LENGTH
    inner_width = 0.18 * THIN_DISK_SCALE_RADIUS
    outer_fade_radius = 4.5 * THIN_DISK_SCALE_RADIUS
    phase_width = 0.8

    inner_taper = 1.0 / (1.0 + np.exp(-(radius_xy - arm_start) / np.maximum(inner_width, 1e-6)))
    outer_taper = 1.0 / (1.0 + (radius_xy / outer_fade_radius) ** 2)
    taper = inner_taper * outer_taper

    reference_radius = max(arm_start, 1.0)
    spiral_phase = arm_count * (
        phi
        - bar_angle
        - np.log(np.maximum(radius_xy, reference_radius) / reference_radius) / np.tan(pitch)
    )
    phase_error = wrap_angle(spiral_phase)

    pull = np.exp(-0.5 * (phase_error / phase_width) ** 2)
    phi_shift = -(arm_strength * taper / arm_count) * phase_error * pull
    phi_shift += rng.normal(0.0, 0.015, size=len(phi_shift)) * taper
    phi_new = phi + phi_shift

    pos[:, 0] = radius_xy * np.cos(phi_new)
    pos[:, 1] = radius_xy * np.sin(phi_new)
    pos[:, 2] = z

    vel[:, 0] = v_r * np.cos(phi_new) - v_phi * np.sin(phi_new)
    vel[:, 1] = v_r * np.sin(phi_new) + v_phi * np.cos(phi_new)
    vel[:, 2] = vz

    return np.column_stack((pos, vel))


def milky_way_bar_density_values(xyz):
    x0 = BAR_HALF_LENGTH
    y0 = BAR_HALF_LENGTH * BAR_AXIS_RATIO_Y
    z0 = BAR_HALF_LENGTH * BAR_AXIS_RATIO_Z
    cutoff = BAR_CUTOFF_RADIUS
    peanut_x = 0.62 * x0
    peanut_y = 0.9 * y0

    x = xyz[:, 0]
    y = xyz[:, 1]
    z = xyz[:, 2]

    ax = np.minimum(np.abs(x) / x0, 1e3)
    ay = np.minimum(np.abs(y) / y0, 1e3)
    az = np.minimum(np.abs(z) / z0, 1e3)

    in_plane = np.power(np.power(ax, 2.2) + np.power(ay, 2.2), 1.0 / 2.2)
    boxy_radius = np.minimum(in_plane + np.power(az, 1.55), 60.0)

    xr = np.clip(x / cutoff, -1e6, 1e6)
    yr = np.clip(y / cutoff, -1e6, 1e6)
    zr = np.clip(z / cutoff, -1e6, 1e6)
    r2 = xr * xr + yr * yr + zr * zr
    outer_taper = np.minimum(r2 * r2, 80.0)

    x_peanut = np.clip(x / peanut_x, -1e6, 1e6)
    z_peanut = np.clip(z / peanut_x, -1e6, 1e6)
    pxp = np.clip(x_peanut + 0.65 * z_peanut, -1e6, 1e6)
    pxm = np.clip(x_peanut - 0.65 * z_peanut, -1e6, 1e6)
    py = np.clip(y / peanut_y, -1e6, 1e6)
    ap = np.minimum(pxp * pxp + py * py, 60.0)
    am = np.minimum(pxm * pxm + py * py, 60.0)
    peanut = 1.0 + 0.30 * (np.exp(-ap) + np.exp(-am))

    return peanut * np.exp(-(boxy_radius**1.18) - outer_taper)


def make_milky_way_bar_density():
    return agama.Density(milky_way_bar_density_values, symmetry="t")


def sample_boxy_bar_positions(count, rng):
    if count <= 0:
        return np.zeros((0, 3), dtype=np.float64)

    x_limit = BAR_CUTOFF_RADIUS
    y_limit = BAR_CUTOFF_RADIUS * 0.8
    z_limit = BAR_CUTOFF_RADIUS * 0.45
    density_ceiling = 1.7

    positions = np.empty((count, 3), dtype=np.float64)
    filled = 0

    while filled < count:
        trial_count = max(2048, 6 * (count - filled))
        trial = np.column_stack(
            (
                rng.uniform(-x_limit, x_limit, size=trial_count),
                rng.uniform(-y_limit, y_limit, size=trial_count),
                rng.uniform(-z_limit, z_limit, size=trial_count),
            )
        )
        density = milky_way_bar_density_values(trial)
        accept = rng.uniform(0.0, density_ceiling, size=trial_count) < density
        accepted = trial[accept]
        take = min(len(accepted), count - filled)
        if take > 0:
            positions[filled : filled + take] = accepted[:take]
            filled += take

    return positions


def build_background_potential(smbh_mass):
    components = []
    if smbh_mass > 0.0:
        components.append(
            agama.Potential(
                type="Plummer",
                mass=smbh_mass,
                scaleRadius=np.sqrt(BACKEND_SOFTENING_SQ),
            )
        )

    components.extend(
        [
            agama.Potential(
                type="Disk",
                mass=THIN_DISK_MASS,
                scaleRadius=THIN_DISK_SCALE_RADIUS,
                scaleHeight=-THIN_DISK_SCALE_HEIGHT,
            ),
            agama.Potential(
                type="Disk",
                mass=THICK_DISK_MASS,
                scaleRadius=THICK_DISK_SCALE_RADIUS,
                scaleHeight=-THICK_DISK_SCALE_HEIGHT,
            ),
            agama.Potential(
                type="Spheroid",
                mass=BAR_MASS,
                scaleRadius=POTENTIAL_BULGE_SCALE_RADIUS,
                outerCutoffRadius=POTENTIAL_BULGE_CUTOFF_RADIUS,
                gamma=0.2,
                beta=3.5,
                axisRatioZ=0.65,
            ),
            agama.Potential(
                type="NFW",
                mass=HALO_MASS,
                scaleRadius=HALO_SCALE_RADIUS,
            ),
        ]
    )

    return agama.Potential(*components)


def build_component_models(potential):
    thin_df = agama.DistributionFunction(
        type="QuasiIsothermal",
        potential=potential,
        Sigma0=sigma0_from_disk_mass(THIN_DISK_MASS, THIN_DISK_SCALE_RADIUS),
        Rdisk=THIN_DISK_SCALE_RADIUS,
        Hdisk=THIN_DISK_SCALE_HEIGHT,
        sigmar0=8.5,
        sigmamin=1.2,
        Rsigmar=2.2 * THIN_DISK_SCALE_RADIUS,
    )
    thick_df = agama.DistributionFunction(
        type="QuasiIsothermal",
        potential=potential,
        Sigma0=sigma0_from_disk_mass(THICK_DISK_MASS, THICK_DISK_SCALE_RADIUS),
        Rdisk=THICK_DISK_SCALE_RADIUS,
        Hdisk=THICK_DISK_SCALE_HEIGHT,
        sigmar0=16.0,
        sigmamin=3.5,
        Rsigmar=1.8 * THICK_DISK_SCALE_RADIUS,
    )
    halo_density = agama.Density(
        type="Spheroid",
        mass=HALO_MASS,
        gamma=1.0,
        beta=3.0,
        scaleRadius=HALO_SCALE_RADIUS,
        outerCutoffRadius=HALO_CUTOFF_RADIUS,
        axisRatioZ=1.0,
    )
    halo_df = agama.DistributionFunction(
        type="QuasiSpherical",
        potential=potential,
        density=halo_density,
    )

    return {
        "thin_disk": agama.GalaxyModel(potential, thin_df),
        "thick_disk": agama.GalaxyModel(potential, thick_df),
        "halo": agama.GalaxyModel(potential, halo_df),
    }


def valid_phase_space_mask(xv):
    if len(xv) == 0:
        return np.zeros(0, dtype=bool)

    finite = np.all(np.isfinite(xv), axis=1)
    if not np.any(finite):
        return finite

    pos_radius = np.linalg.norm(xv[:, :3], axis=1)
    speed = np.linalg.norm(xv[:, 3:], axis=1)
    return finite & (pos_radius < MAX_SAMPLE_RADIUS) & (speed < MAX_SAMPLE_SPEED)


def resilient_sample(draw_fn, count, label):
    if count <= 0:
        return np.zeros((0, 6), dtype=np.float64)

    parts = []
    kept = 0
    for _ in range(6):
        need = count - kept
        if need <= 0:
            break
        xv = np.asarray(draw_fn(need), dtype=np.float64)
        valid = valid_phase_space_mask(xv)
        if np.any(valid):
            accepted = xv[valid]
            parts.append(accepted)
            kept += len(accepted)

    if kept < count:
        raise RuntimeError(f"Failed to obtain {count} valid {label} samples from AGAMA")

    return np.vstack(parts)[:count]


def sample_galaxy_model(model, count, label):
    return resilient_sample(lambda need: model.sample(need)[0], count, label)


def sample_bar_component(count, potential, rng):
    if count <= 0:
        return np.zeros((0, 6), dtype=np.float64)

    pos = sample_boxy_bar_positions(count, rng)
    x = pos[:, 0]
    y = pos[:, 1]

    radius_xy = np.sqrt(x * x + y * y)
    phi = np.arctan2(y, x)

    v_c = circular_velocity_from_potential(potential, np.maximum(radius_xy, 0.35 * BAR_HALF_LENGTH))
    streaming = 0.72 * v_c * np.tanh(radius_xy / np.maximum(0.45 * BAR_HALF_LENGTH, 1e-6))
    sigma_r = 0.36 * v_c + 1.5
    sigma_phi = 0.28 * v_c + 1.0
    sigma_z = 0.22 * v_c + 0.8

    v_r = rng.normal(0.0, sigma_r, size=count)
    v_phi = streaming + rng.normal(0.0, sigma_phi, size=count)
    v_z = rng.normal(0.0, sigma_z, size=count)

    vel = np.zeros_like(pos)
    vel[:, 0] = v_r * np.cos(phi) - v_phi * np.sin(phi)
    vel[:, 1] = v_r * np.sin(phi) + v_phi * np.cos(phi)
    vel[:, 2] = v_z

    return np.column_stack((pos, vel))


def generate_milky_way_snapshot(
    num_particles=10000,
    seed=42,
    smbh_mass=DEFAULT_SMBH_MASS,
    smbh_exclusion_radius=DEFAULT_SMBH_EXCLUSION_RADIUS,
    bar_angle_deg=DEFAULT_BAR_ANGLE_DEG,
    arm_pitch_deg=DEFAULT_ARM_PITCH_DEG,
    arm_strength=DEFAULT_ARM_STRENGTH,
):
    rng = np.random.default_rng(seed)

    if num_particles < 1:
        raise ValueError("num_particles must be >= 1")

    agama.setUnits(length=1, velocity=1, mass=AGAMA_G1_MASS_UNIT)

    has_smbh = smbh_mass > 0.0
    sampled_particles = num_particles - 1 if has_smbh else num_particles
    if sampled_particles < 1:
        raise ValueError("num_particles must be >= 2 when smbh_mass > 0")

    potential = build_background_potential(smbh_mass=smbh_mass)
    models = build_component_models(potential)

    n_thin, n_thick, n_bar, n_halo = component_counts(
        sampled_particles,
        fractions=(
            THIN_DISK_FRACTION,
            THICK_DISK_FRACTION,
            BAR_FRACTION,
            HALO_FRACTION,
        ),
    )

    thin_xv = sample_galaxy_model(models["thin_disk"], n_thin, "thin-disk")
    thick_xv = sample_galaxy_model(models["thick_disk"], n_thick, "thick-disk")
    bar_xv = sample_bar_component(n_bar, potential=potential, rng=rng)
    halo_xv = sample_galaxy_model(models["halo"], n_halo, "halo")

    thin_xv = enforce_minimum_radius(thin_xv, smbh_exclusion_radius, rng)
    thick_xv = enforce_minimum_radius(thick_xv, smbh_exclusion_radius, rng)
    bar_xv = enforce_minimum_radius(bar_xv, smbh_exclusion_radius, rng)
    halo_xv = enforce_minimum_radius(halo_xv, smbh_exclusion_radius, rng)

    thin_xv = apply_spiral_arms(
        thin_xv,
        rng=rng,
        bar_angle_deg=bar_angle_deg,
        arm_pitch_deg=arm_pitch_deg,
        arm_strength=arm_strength,
    )

    bar_angle_rad = np.deg2rad(bar_angle_deg)
    bar_xv[:, :3] = rotate_xy(bar_xv[:, :3], bar_angle_rad)
    bar_xv[:, 3:] = rotate_xy(bar_xv[:, 3:], bar_angle_rad)

    position_parts = [
        thin_xv[:, :3],
        thick_xv[:, :3],
        bar_xv[:, :3],
        halo_xv[:, :3],
    ]
    velocity_parts = [
        thin_xv[:, 3:],
        thick_xv[:, 3:],
        bar_xv[:, 3:],
        halo_xv[:, 3:],
    ]
    masses = np.concatenate(
        [
            np.full(n_thin, THIN_DISK_MASS / max(n_thin, 1), dtype=np.float64),
            np.full(n_thick, THICK_DISK_MASS / max(n_thick, 1), dtype=np.float64),
            np.full(n_bar, BAR_MASS / max(n_bar, 1), dtype=np.float64),
            np.full(n_halo, HALO_MASS / max(n_halo, 1), dtype=np.float64),
        ]
    )

    positions = np.vstack(position_parts).astype(np.float64, copy=False)
    velocities = np.vstack(velocity_parts).astype(np.float64, copy=False)
    positions, velocities = recenter_phase_space(positions, velocities, masses)

    if has_smbh:
        positions = np.vstack((np.array([[0.0, 0.0, 0.0]], dtype=np.float64), positions))
        velocities = np.vstack((np.array([[0.0, 0.0, 0.0]], dtype=np.float64), velocities))
        masses = np.concatenate((np.array([smbh_mass], dtype=np.float64), masses))

    forces = potential.force(positions).astype(np.float32, copy=False)

    print("--- Milky Way Snapshot Generation Complete ---")
    print(f"Particles total:       {num_particles}")
    print(f"Thin/Thick/Bar/Halo:   {n_thin}/{n_thick}/{n_bar}/{n_halo}")
    print(f"SMBH mass:             {smbh_mass:.3f}")
    print(f"SMBH exclusion R:      {smbh_exclusion_radius:.3f}")
    print(f"Bar angle (deg):       {bar_angle_deg:.1f}")
    print(f"Spiral pitch (deg):    {arm_pitch_deg:.1f}")
    print(f"Spiral strength:       {arm_strength:.2f}")
    print("AGAMA gravity scale:   G = 1")
    print(f"Positions shape:       {positions.shape}")
    print(f"Velocities shape:      {velocities.shape}")
    print(f"Masses shape:          {masses.shape}")
    print(f"Forces shape:          {forces.shape}")

    return (
        positions.astype(np.float32, copy=False),
        velocities.astype(np.float32, copy=False),
        masses.astype(np.float32, copy=False),
        forces,
    )


def parse_args():
    parser = argparse.ArgumentParser(description="Generate a Milky Way-like AGAMA snapshot")
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
        help="minimum spawn radius around SMBH to reduce plunging/ejections",
    )
    parser.add_argument(
        "--bar-angle-deg",
        type=float,
        default=DEFAULT_BAR_ANGLE_DEG,
        help="orientation angle of the Galactic bar in degrees",
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
        help="strength of the spiral-arm azimuthal crowding",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=str(Path(__file__).with_name("galaxy.bin")),
        help="output binary snapshot path",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    pos, vel, mass, frc = generate_milky_way_snapshot(
        num_particles=args.n,
        seed=args.seed,
        smbh_mass=args.smbh_mass,
        smbh_exclusion_radius=args.smbh_exclusion_radius,
        bar_angle_deg=args.bar_angle_deg,
        arm_pitch_deg=args.arm_pitch_deg,
        arm_strength=args.arm_strength,
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
