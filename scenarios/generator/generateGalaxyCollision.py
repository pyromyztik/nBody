import argparse
from pathlib import Path

import numpy as np

from generateGalaxy import (
    DEFAULT_SMBH_EXCLUSION_RADIUS,
    DEFAULT_SMBH_MASS,
    GALAXY_SCALE,
    PRESET_CHOICES,
    generate_milky_way_snapshot,
    write_agama_binary_snapshot,
)


PRIMARY_GALAXY_SIZE_SCALE = 2.5
PRIMARY_GALAXY_MASS_SCALE = 3
SECONDARY_GALAXY_SIZE_SCALE = 1
SECONDARY_GALAXY_MASS_SCALE = 0.6

# Choose each progenitor's internal structure preset here.
PRIMARY_GALAXY_PRESET = "cinematic"
SECONDARY_GALAXY_PRESET = "grand-design"

# Merger-biased encounter tuning knobs.
BASE_ENCOUNTER_DIRECTION = np.array([1.35, 0.35, 0.20], dtype=np.float64)
INITIAL_SEPARATION_MULTIPLIER = 3.3

PRIMARY_GALAXY_ROTATION_DEG = (18.0, -8.0, 24.0)
SECONDARY_GALAXY_ROTATION_DEG = (10.0, 4.0, 14.0)

RADIAL_SPEED_FACTOR = -1.10
TANGENTIAL_SPEED_FACTOR = 0.12
VERTICAL_SPEED_FACTOR = 0.05
ENCOUNTER_SPEED_SCALE = 0.82


def split_body_count(total_count):
    if total_count < 4:
        raise ValueError("num_particles must be >= 4 for a two-galaxy collision")

    total_mass = PRIMARY_GALAXY_MASS_SCALE + SECONDARY_GALAXY_MASS_SCALE
    primary_ratio = PRIMARY_GALAXY_MASS_SCALE / total_mass

    primary_count = int(round(total_count * primary_ratio))
    
    primary_count = max(2, min(primary_count, total_count - 2))
    secondary_count = total_count - primary_count

    return primary_count, secondary_count


def rotation_matrix_xyz(rx_deg, ry_deg, rz_deg):
    rx = np.deg2rad(rx_deg)
    ry = np.deg2rad(ry_deg)
    rz = np.deg2rad(rz_deg)

    cx, sx = np.cos(rx), np.sin(rx)
    cy, sy = np.cos(ry), np.sin(ry)
    cz, sz = np.cos(rz), np.sin(rz)

    rot_x = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, cx, -sx],
            [0.0, sx, cx],
        ],
        dtype=np.float64,
    )
    rot_y = np.array(
        [
            [cy, 0.0, sy],
            [0.0, 1.0, 0.0],
            [-sy, 0.0, cy],
        ],
        dtype=np.float64,
    )
    rot_z = np.array(
        [
            [cz, -sz, 0.0],
            [sz, cz, 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )

    return rot_z @ rot_y @ rot_x


def recenter_snapshot(positions, velocities, masses):
    weights = np.asarray(masses, dtype=np.float64)
    total_mass = float(np.sum(weights))
    if total_mass <= 0.0:
        raise ValueError("snapshot mass must be positive")

    centered_positions = np.asarray(positions, dtype=np.float64) - np.average(
        positions, axis=0, weights=weights
    )
    centered_velocities = np.asarray(velocities, dtype=np.float64) - np.average(
        velocities, axis=0, weights=weights
    )
    return centered_positions, centered_velocities


def transform_snapshot(positions, velocities, masses, size_scale, mass_scale, rotation, translation, boost):
    velocity_scale = np.sqrt(mass_scale / size_scale)

    transformed_positions = (positions @ rotation.T) * size_scale + translation
    transformed_velocities = (velocities @ rotation.T) * velocity_scale + boost
    transformed_masses = np.asarray(masses, dtype=np.float64) * mass_scale

    return transformed_positions, transformed_velocities, transformed_masses


def encounter_basis(relative_position):
    radial_hat = relative_position / np.linalg.norm(relative_position)

    reference_up = np.array([0.0, 0.0, 1.0], dtype=np.float64)
    tangential_hat = np.cross(reference_up, radial_hat)
    tangent_norm = np.linalg.norm(tangential_hat)

    if tangent_norm < 1e-8:
        tangential_hat = np.cross(np.array([0.0, 1.0, 0.0], dtype=np.float64), radial_hat)
        tangent_norm = np.linalg.norm(tangential_hat)

    tangential_hat /= tangent_norm
    vertical_hat = np.cross(radial_hat, tangential_hat)
    vertical_hat /= np.linalg.norm(vertical_hat)

    return radial_hat, tangential_hat, vertical_hat


def generate_galaxy_collision_snapshot(
    num_particles=10000,
    seed=42,
    smbh_mass=DEFAULT_SMBH_MASS,
    smbh_exclusion_radius=DEFAULT_SMBH_EXCLUSION_RADIUS,
):
    if PRIMARY_GALAXY_PRESET not in PRESET_CHOICES:
        raise ValueError(
            f"PRIMARY_GALAXY_PRESET must be one of {PRESET_CHOICES}; got {PRIMARY_GALAXY_PRESET!r}"
        )
    if SECONDARY_GALAXY_PRESET not in PRESET_CHOICES:
        raise ValueError(
            f"SECONDARY_GALAXY_PRESET must be one of {PRESET_CHOICES}; got {SECONDARY_GALAXY_PRESET!r}"
        )

    primary_count, secondary_count = split_body_count(num_particles)

    primary_positions, primary_velocities, primary_masses, _ = generate_milky_way_snapshot(
        preset=PRIMARY_GALAXY_PRESET,
        num_particles=primary_count,
        seed=seed,
        smbh_mass=smbh_mass,
        smbh_exclusion_radius=smbh_exclusion_radius,
    )
    secondary_positions, secondary_velocities, secondary_masses, _ = generate_milky_way_snapshot(
        preset=SECONDARY_GALAXY_PRESET,
        num_particles=secondary_count,
        seed=seed + 1,
        smbh_mass=smbh_mass,
        smbh_exclusion_radius=smbh_exclusion_radius,
    )

    primary_positions, primary_velocities = recenter_snapshot(primary_positions, primary_velocities, primary_masses)
    secondary_positions, secondary_velocities = recenter_snapshot(secondary_positions, secondary_velocities, secondary_masses)

    base_disk_radius = 90.0 * GALAXY_SCALE
    interaction_scale = (PRIMARY_GALAXY_SIZE_SCALE + SECONDARY_GALAXY_SIZE_SCALE) * base_disk_radius
    relative_position = BASE_ENCOUNTER_DIRECTION * interaction_scale * INITIAL_SEPARATION_MULTIPLIER

    primary_mass_total = float(np.sum(primary_masses)) * PRIMARY_GALAXY_MASS_SCALE
    secondary_mass_total = float(np.sum(secondary_masses)) * SECONDARY_GALAXY_MASS_SCALE
    total_mass = primary_mass_total + secondary_mass_total

    separation = float(np.linalg.norm(relative_position))
    circular_speed = np.sqrt(total_mass / separation)

    radial_hat, tangential_hat, vertical_hat = encounter_basis(relative_position)
    relative_velocity = (
        RADIAL_SPEED_FACTOR * circular_speed * radial_hat
        + TANGENTIAL_SPEED_FACTOR * circular_speed * tangential_hat
        + VERTICAL_SPEED_FACTOR * circular_speed * vertical_hat
    )
    relative_velocity *= ENCOUNTER_SPEED_SCALE

    primary_translation = -relative_position * (secondary_mass_total / total_mass)
    secondary_translation = relative_position * (primary_mass_total / total_mass)

    primary_boost = -relative_velocity * (secondary_mass_total / total_mass)
    secondary_boost = relative_velocity * (primary_mass_total / total_mass)

    primary_rotation = rotation_matrix_xyz(*PRIMARY_GALAXY_ROTATION_DEG)
    secondary_rotation = rotation_matrix_xyz(*SECONDARY_GALAXY_ROTATION_DEG)

    primary_positions, primary_velocities, primary_masses = transform_snapshot(
        positions=primary_positions,
        velocities=primary_velocities,
        masses=primary_masses,
        size_scale=PRIMARY_GALAXY_SIZE_SCALE,
        mass_scale=PRIMARY_GALAXY_MASS_SCALE,
        rotation=primary_rotation,
        translation=primary_translation,
        boost=primary_boost,
    )
    secondary_positions, secondary_velocities, secondary_masses = transform_snapshot(
        positions=secondary_positions,
        velocities=secondary_velocities,
        masses=secondary_masses,
        size_scale=SECONDARY_GALAXY_SIZE_SCALE,
        mass_scale=SECONDARY_GALAXY_MASS_SCALE,
        rotation=secondary_rotation,
        translation=secondary_translation,
        boost=secondary_boost,
    )

    positions = np.vstack((primary_positions, secondary_positions)).astype(np.float32, copy=False)
    velocities = np.vstack((primary_velocities, secondary_velocities)).astype(np.float32, copy=False)
    masses = np.concatenate((primary_masses, secondary_masses)).astype(np.float32, copy=False)
    forces = np.zeros_like(positions, dtype=np.float32)

    print("--- Two-Galaxy Collision Snapshot Generation Complete ---")
    print(f"Particles total:        {num_particles}")
    print(f"Primary/secondary galaxy N:   {primary_count}/{secondary_count}")
    print(f"Primary preset:           {PRIMARY_GALAXY_PRESET}")
    print(f"Secondary preset:           {SECONDARY_GALAXY_PRESET}")
    print(f"Size scale ratio:       {PRIMARY_GALAXY_SIZE_SCALE:.1f}:1")
    print(f"Mass scale ratio:       {PRIMARY_GALAXY_MASS_SCALE:.1f}:1")
    print(f"Encounter direction:    {BASE_ENCOUNTER_DIRECTION}")
    print(f"Separation multiplier:  {INITIAL_SEPARATION_MULTIPLIER:.2f}x")
    print(f"Encounter speed scale:  {ENCOUNTER_SPEED_SCALE:.2f}")
    print(f"Primary rotation (deg):   {PRIMARY_GALAXY_ROTATION_DEG}")
    print(f"Secondary rotation (deg):   {SECONDARY_GALAXY_ROTATION_DEG}")
    print(f"Initial separation:     {separation:.3f}")
    print(f"Relative speed:         {np.linalg.norm(relative_velocity):.3f}")
    print(f"Primary galaxy offset:    {primary_translation}")
    print(f"Secondary galaxy offset:    {secondary_translation}")
    print(f"Positions shape:        {positions.shape}")
    print(f"Velocities shape:       {velocities.shape}")
    print(f"Masses shape:           {masses.shape}")
    print(f"Forces shape:           {forces.shape}")

    return positions, velocities, masses, forces


def parse_args():
    parser = argparse.ArgumentParser(description="Generate a two-galaxy collision AGAMA snapshot")
    parser.add_argument("--n", type=int, default=10000, help="number of bodies")
    parser.add_argument("--seed", type=int, default=42, help="random seed")
    parser.add_argument(
        "--smbh-mass",
        type=float,
        default=DEFAULT_SMBH_MASS,
        help="central supermassive black hole mass in toy units for each galaxy",
    )
    parser.add_argument(
        "--smbh-exclusion-radius",
        type=float,
        default=DEFAULT_SMBH_EXCLUSION_RADIUS,
        help="minimum spawn radius around each SMBH to reduce plunging/ejections",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=str(Path(__file__).resolve().parent.parent / "galaxy_collision_30k.bin"),
        help="output binary snapshot path",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    pos, vel, mass, frc = generate_galaxy_collision_snapshot(
        num_particles=args.n,
        seed=args.seed,
        smbh_mass=args.smbh_mass,
        smbh_exclusion_radius=args.smbh_exclusion_radius,
    )
    write_agama_binary_snapshot(
        output_path=args.out,
        positions=pos,
        velocities=vel,
        masses=mass,
        forces=frc,
    )
