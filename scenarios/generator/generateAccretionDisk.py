import argparse
from pathlib import Path

import numpy as np


AGAMA_SNAPSHOT_MAGIC = 0x314D4741  # 'AGM1' in little-endian
DEFAULT_G = 1.0
DEFAULT_SOFTENING_SQ = 0.1
DEFAULT_CENTRAL_MASS = 100000.0
DEFAULT_MAX_RADIUS = 500.0
DEFAULT_DISK_THICKNESS = 5.0
DEFAULT_MIN_RADIUS_FRACTION = 0.05
DEFAULT_BODY_MASS_MIN = 1.0
DEFAULT_BODY_MASS_MAX = 10.0
DEFAULT_SEED = 42


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

    magic = np.array([AGAMA_SNAPSHOT_MAGIC], dtype=np.uint32)
    n = np.array([count], dtype=np.uint32)
    with out.open("wb") as fp:
        fp.write(magic.tobytes())
        fp.write(n.tobytes())
        fp.write(rows.tobytes())


def generate_accretion_disk_snapshot(
    body_count,
    g_const=DEFAULT_G,
    softening_sq=DEFAULT_SOFTENING_SQ,
    central_mass=DEFAULT_CENTRAL_MASS,
    max_radius=DEFAULT_MAX_RADIUS,
    disk_thickness=DEFAULT_DISK_THICKNESS,
    min_radius_fraction=DEFAULT_MIN_RADIUS_FRACTION,
    body_mass_min=DEFAULT_BODY_MASS_MIN,
    body_mass_max=DEFAULT_BODY_MASS_MAX,
    seed=DEFAULT_SEED,
):
    if body_count < 2:
        raise ValueError("body_count must be >= 2")
    if central_mass <= 0.0:
        raise ValueError("central_mass must be > 0")
    if max_radius <= 0.0:
        raise ValueError("max_radius must be > 0")
    if disk_thickness < 0.0:
        raise ValueError("disk_thickness must be >= 0")
    if not (0.0 < min_radius_fraction <= 1.0):
        raise ValueError("min_radius_fraction must be in (0, 1]")
    if body_mass_min <= 0.0 or body_mass_max <= 0.0:
        raise ValueError("body masses must be > 0")
    if body_mass_min > body_mass_max:
        raise ValueError("body_mass_min cannot exceed body_mass_max")
    if softening_sq < 0.0:
        raise ValueError("softening_sq must be >= 0")
    if g_const <= 0.0:
        raise ValueError("g_const must be > 0")

    rng = np.random.default_rng(seed)

    positions = np.zeros((body_count, 3), dtype=np.float64)
    velocities = np.zeros((body_count, 3), dtype=np.float64)
    masses = np.zeros(body_count, dtype=np.float64)
    forces = np.zeros((body_count, 3), dtype=np.float64)

    # central supermassive body at the origin
    masses[0] = central_mass

    count_orbiting = body_count - 1
    radius_samples = rng.uniform(min_radius_fraction, 1.0, size=count_orbiting)
    radii = max_radius * np.sqrt(radius_samples)
    angles = rng.uniform(0.0, 2.0 * np.pi, size=count_orbiting)
    z = rng.uniform(-disk_thickness, disk_thickness, size=count_orbiting)

    x = radii * np.cos(angles)
    y = radii * np.sin(angles)

    positions[1:, 0] = x
    positions[1:, 1] = y
    positions[1:, 2] = z

    masses[1:] = rng.uniform(body_mass_min, body_mass_max, size=count_orbiting)

    r2 = radii * radii
    softened = np.sqrt(r2 + softening_sq)
    speed = np.sqrt((g_const * central_mass * r2) / np.power(softened, 3.0))

    velocities[1:, 0] = -speed * (y / radii)
    velocities[1:, 1] = speed * (x / radii)

    return positions, velocities, masses, forces


def parse_args():
    parser = argparse.ArgumentParser(description="Generate an accretion-disk AGAMA snapshot")
    parser.add_argument("--bodies", type=int, required=True, help="number of bodies (>= 2)")
    parser.add_argument("--out", type=str, default=str(Path(__file__).with_name("scenario.bin")), help="output snapshot path")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="random seed")
    parser.add_argument("--g", type=float, default=DEFAULT_G, help="gravitational constant")
    parser.add_argument("--softening-sq", type=float, default=DEFAULT_SOFTENING_SQ, help="softening squared")
    parser.add_argument("--central-mass", type=float, default=DEFAULT_CENTRAL_MASS, help="mass of central body")
    parser.add_argument(
        "--radius",
        "--max-radius",
        dest="max_radius",
        type=float,
        default=DEFAULT_MAX_RADIUS,
        help="maximum disk radius",
    )
    parser.add_argument("--disk-thickness", type=float, default=DEFAULT_DISK_THICKNESS, help="half-thickness of the disk")
    parser.add_argument(
        "--min-radius-fraction",
        type=float,
        default=DEFAULT_MIN_RADIUS_FRACTION,
        help="minimum radius as a fraction of max-radius",
    )
    parser.add_argument("--body-mass-min", type=float, default=DEFAULT_BODY_MASS_MIN, help="minimum orbiting body mass")
    parser.add_argument("--body-mass-max", type=float, default=DEFAULT_BODY_MASS_MAX, help="maximum orbiting body mass")
    return parser.parse_args()


def main():
    args = parse_args()

    positions, velocities, masses, forces = generate_accretion_disk_snapshot(
        body_count=args.bodies,
        g_const=args.g,
        softening_sq=args.softening_sq,
        central_mass=args.central_mass,
        max_radius=args.max_radius,
        disk_thickness=args.disk_thickness,
        min_radius_fraction=args.min_radius_fraction,
        body_mass_min=args.body_mass_min,
        body_mass_max=args.body_mass_max,
        seed=args.seed,
    )

    write_agama_binary_snapshot(
        output_path=args.out,
        positions=positions,
        velocities=velocities,
        masses=masses,
        forces=forces,
    )

    print("--- Accretion Disk Snapshot Generation Complete ---")
    print(f"Bodies:       {args.bodies}")
    print(f"Central mass: {args.central_mass:.3f}")
    print(f"Max radius:   {args.max_radius:.3f}")
    print(f"Output:       {args.out}")


if __name__ == "__main__":
    main()
