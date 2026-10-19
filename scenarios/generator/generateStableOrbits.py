import argparse
from pathlib import Path

import numpy as np


AGAMA_SNAPSHOT_MAGIC = 0x314D4741  # 'AGM1' in little-endian
DEFAULT_SOFTENING_SQ = 0.1
DEFAULT_G = 1.0
DEFAULT_BODY_MASS = 100.0
BASE_RADIUS_BY_COUNT = {
    2: 40.0,
    3: 45.0,
    4: 50.0,
    5: 55.0,
    6: 60.0,
    7: 65.0,
    8: 70.0,
}
AVAILABLE_FAMILIES = (
    "auto",
    "polygon",
    "multiring",
    "wheel",
    "hierarchical",
    "bhh",
    "suvakov-dmitrasinovic",
    "retrograde",
    "interplay",
    "figure8",
    "lagrange-3",
    "euler-3",
)


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


def default_radius_for_count(body_count):
    if body_count in BASE_RADIUS_BY_COUNT:
        return BASE_RADIUS_BY_COUNT[body_count]

    # Keep angular crowding moderate for large N.
    base_n = 8.0
    base_radius = BASE_RADIUS_BY_COUNT[8]
    return float(base_radius * np.power(max(float(body_count), 2.0) / base_n, 0.60))


def canonical_family_name(family):
    key = family.strip().lower()
    aliases = {
        "ring": "polygon",
        "lagrange": "lagrange-3",
        "lagrange3": "lagrange-3",
        "euler": "euler-3",
        "euler3": "euler-3",
        "figure-8": "figure8",
        "figure83": "figure8",
        "figure8-3": "figure8",
        "hierarchical-binary-tertiary": "hierarchical",
        "broucke-hadjidemetriou-henon": "bhh",
        "suvakov-dmitrasinovic": "suvakov-dmitrasinovic",
        "suvakov-dmitrasinovic-family": "suvakov-dmitrasinovic",
        "šuvakov-dmitrašinović": "suvakov-dmitrasinovic",
        "retrograde/interplay": "interplay",
    }
    key = aliases.get(key, key)
    if key not in AVAILABLE_FAMILIES:
        allowed = ", ".join(AVAILABLE_FAMILIES)
        raise ValueError(f"unknown family {family!r}; available: {allowed}")
    return key


def polygon_inward_sum(body_count, radius, softening_sq):
    if body_count < 2:
        return 0.0

    k = np.arange(1, body_count, dtype=np.float64)
    half_angles = np.pi * k / float(body_count)
    s = np.sin(half_angles)

    distance_sq = 4.0 * radius * radius * s * s
    denom = np.power(distance_sq + softening_sq, 1.5)
    inward_sum = np.sum((2.0 * radius * radius * s * s) / denom)
    return float(inward_sum)


def polygon_orbital_speed(body_count, radius, body_mass, softening_sq, g_const=DEFAULT_G):
    if body_count < 2:
        raise ValueError("body_count must be at least 2")
    if radius <= 0.0:
        raise ValueError("radius must be > 0")
    if body_mass <= 0.0:
        raise ValueError("body_mass must be > 0")
    if softening_sq < 0.0:
        raise ValueError("softening_sq must be >= 0")

    inward_sum = polygon_inward_sum(body_count, radius, softening_sq)
    speed_sq = g_const * body_mass * inward_sum
    return float(np.sqrt(max(speed_sq, 0.0)))


def compute_softened_accelerations(positions, masses, softening_sq, g_const):
    n = positions.shape[0]
    accel = np.zeros_like(positions, dtype=np.float64)
    if n <= 1:
        return accel

    for i in range(n):
        dx = positions - positions[i]
        dist_sq = np.einsum("ij,ij->i", dx, dx)
        inv_dist3 = np.power(dist_sq + softening_sq, -1.5)
        inv_dist3[i] = 0.0

        scale = masses * inv_dist3
        accel[i] = g_const * np.sum(dx * scale[:, None], axis=0)

    return accel


def recenter_phase_space(positions, velocities, masses):
    total_mass = float(np.sum(masses))
    if total_mass <= 0.0:
        raise ValueError("total mass must be positive")

    centered_positions = positions - np.average(positions, axis=0, weights=masses)
    centered_velocities = velocities - np.average(velocities, axis=0, weights=masses)
    return centered_positions, centered_velocities


def finalize_snapshot(positions, velocities, masses):
    positions = np.asarray(positions, dtype=np.float64)
    velocities = np.asarray(velocities, dtype=np.float64)
    masses = np.asarray(masses, dtype=np.float64)
    forces = np.zeros((positions.shape[0], 3), dtype=np.float64)

    positions, velocities = recenter_phase_space(positions, velocities, masses)
    total_mass = float(np.sum(masses))
    return positions, velocities, masses, forces, total_mass


def assign_radial_balanced_tangential_velocities(
    positions,
    masses,
    softening_sq,
    clockwise,
    g_const,
    direction_pattern=None,
):
    accel = compute_softened_accelerations(
        positions=positions,
        masses=masses,
        softening_sq=softening_sq,
        g_const=g_const,
    )

    velocities = np.zeros_like(positions, dtype=np.float64)
    global_sign = -1.0 if clockwise else 1.0
    for i in range(positions.shape[0]):
        x = positions[i, 0]
        y = positions[i, 1]
        r = np.hypot(x, y)
        if r <= 1e-12:
            continue

        radial_hat = np.array([x / r, y / r, 0.0], dtype=np.float64)
        inward_accel = -float(np.dot(accel[i], radial_hat))
        speed = np.sqrt(max(inward_accel * r, 0.0))

        tangential_hat = np.array([-y / r, x / r, 0.0], dtype=np.float64)
        local_sign = 1.0
        if direction_pattern is not None:
            local_sign = float(direction_pattern[i])
        velocities[i] = tangential_hat * speed * global_sign * local_sign

    return velocities


def build_stable_polygon_snapshot(
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise=False,
    g_const=DEFAULT_G,
):
    angles = np.linspace(0.0, 2.0 * np.pi, num=body_count, endpoint=False, dtype=np.float64)

    positions = np.zeros((body_count, 3), dtype=np.float64)
    positions[:, 0] = radius * np.cos(angles)
    positions[:, 1] = radius * np.sin(angles)

    speed = polygon_orbital_speed(
        body_count=body_count,
        radius=radius,
        body_mass=body_mass,
        softening_sq=softening_sq,
        g_const=g_const,
    )

    tangential = np.zeros((body_count, 3), dtype=np.float64)
    tangential[:, 0] = -np.sin(angles)
    tangential[:, 1] = np.cos(angles)
    if clockwise:
        tangential *= -1.0

    velocities = tangential * speed
    masses = np.full(body_count, body_mass, dtype=np.float64)

    positions, velocities, masses, forces, total_mass = finalize_snapshot(
        positions=positions,
        velocities=velocities,
        masses=masses,
    )
    return positions, velocities, masses, forces, speed, total_mass


def build_multiring_snapshot(
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise=False,
    g_const=DEFAULT_G,
    ring_spacing=1.65,
):
    if body_count < 4:
        raise ValueError("multiring family requires at least 4 bodies")

    positions = []
    remaining = int(body_count)
    ring_index = 1

    while remaining > 0:
        capacity = max(6, 6 * ring_index)
        count = min(remaining, capacity)
        ring_radius = radius * np.power(ring_spacing, ring_index - 1)

        angles = np.linspace(0.0, 2.0 * np.pi, num=count, endpoint=False, dtype=np.float64)
        ring_pos = np.column_stack(
            (
                ring_radius * np.cos(angles),
                ring_radius * np.sin(angles),
                np.zeros(count, dtype=np.float64),
            )
        )
        positions.append(ring_pos)

        remaining -= count
        ring_index += 1

    positions = np.vstack(positions)
    masses = np.full(body_count, body_mass, dtype=np.float64)
    velocities = assign_radial_balanced_tangential_velocities(
        positions=positions,
        masses=masses,
        softening_sq=softening_sq,
        clockwise=clockwise,
        g_const=g_const,
    )

    speeds = np.linalg.norm(velocities[:, :2], axis=1)
    speed = float(np.mean(speeds)) if len(speeds) else 0.0

    positions, velocities, masses, forces, total_mass = finalize_snapshot(
        positions=positions,
        velocities=velocities,
        masses=masses,
    )
    return positions, velocities, masses, forces, speed, total_mass


def build_wheel_snapshot(
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise=False,
    g_const=DEFAULT_G,
    center_mass_multiplier=2.5,
):
    if body_count < 3:
        raise ValueError("wheel family requires at least 3 bodies")

    ring_count = body_count - 1
    center_mass = float(body_mass * max(center_mass_multiplier, 0.1))

    angles = np.linspace(0.0, 2.0 * np.pi, num=ring_count, endpoint=False, dtype=np.float64)
    ring_positions = np.column_stack(
        (
            radius * np.cos(angles),
            radius * np.sin(angles),
            np.zeros(ring_count, dtype=np.float64),
        )
    )

    positions = np.vstack((np.zeros((1, 3), dtype=np.float64), ring_positions))
    masses = np.concatenate(
        (
            np.array([center_mass], dtype=np.float64),
            np.full(ring_count, body_mass, dtype=np.float64),
        )
    )

    center_term = g_const * center_mass * (radius * radius) / np.power(radius * radius + softening_sq, 1.5)
    ring_term = g_const * body_mass * polygon_inward_sum(ring_count, radius, softening_sq)
    ring_speed = float(np.sqrt(max(center_term + ring_term, 0.0)))

    velocities = np.zeros_like(positions, dtype=np.float64)
    tangential = np.column_stack(
        (
            -np.sin(angles),
            np.cos(angles),
            np.zeros(ring_count, dtype=np.float64),
        )
    )
    if clockwise:
        tangential *= -1.0
    velocities[1:, :] = tangential * ring_speed

    positions, velocities, masses, forces, total_mass = finalize_snapshot(
        positions=positions,
        velocities=velocities,
        masses=masses,
    )
    return positions, velocities, masses, forces, ring_speed, total_mass


def build_lagrange_3_snapshot(
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise=False,
    g_const=DEFAULT_G,
):
    if body_count != 3:
        raise ValueError("lagrange-3 family requires --bodies 3")

    return build_stable_polygon_snapshot(
        body_count=3,
        radius=radius,
        body_mass=body_mass,
        softening_sq=softening_sq,
        clockwise=clockwise,
        g_const=g_const,
    )


def build_euler_3_snapshot(
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise=False,
    g_const=DEFAULT_G,
):
    if body_count != 3:
        raise ValueError("euler-3 family requires --bodies 3")

    a = float(radius)
    if a <= 0.0:
        raise ValueError("radius must be > 0")

    positions = np.array(
        [
            [-a, 0.0, 0.0],
            [0.0, 0.0, 0.0],
            [a, 0.0, 0.0],
        ],
        dtype=np.float64,
    )
    masses = np.full(3, body_mass, dtype=np.float64)

    omega_sq = g_const * body_mass * (
        1.0 / np.power(a * a + softening_sq, 1.5)
        + 2.0 / np.power(4.0 * a * a + softening_sq, 1.5)
    )
    omega = float(np.sqrt(max(omega_sq, 0.0)))

    velocities = np.array(
        [
            [0.0, -omega * a, 0.0],
            [0.0, 0.0, 0.0],
            [0.0, omega * a, 0.0],
        ],
        dtype=np.float64,
    )
    if clockwise:
        velocities *= -1.0

    speed = float(abs(omega * a))
    positions, velocities, masses, forces, total_mass = finalize_snapshot(
        positions=positions,
        velocities=velocities,
        masses=masses,
    )
    return positions, velocities, masses, forces, speed, total_mass


def build_hierarchical_binary_tertiary_snapshot(
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise=False,
    g_const=DEFAULT_G,
    binary_mass_multiplier=2.0,
    outer_mode="prograde",
):
    if body_count < 3:
        raise ValueError("hierarchical family requires at least 3 bodies")

    inner_mass = float(body_mass * max(binary_mass_multiplier, 0.1))
    inner_radius = max(0.22 * radius, 1e-6)
    outer_radius = max(radius, 1.8 * inner_radius)

    positions = [
        np.array([-inner_radius, 0.0, 0.0], dtype=np.float64),
        np.array([inner_radius, 0.0, 0.0], dtype=np.float64),
    ]
    masses = [inner_mass, inner_mass]

    outer_count = body_count - 2
    outer_angles = np.linspace(0.0, 2.0 * np.pi, num=outer_count, endpoint=False, dtype=np.float64)
    if outer_count == 1:
        outer_angles = np.array([0.0], dtype=np.float64)

    for angle in outer_angles:
        positions.append(np.array([outer_radius * np.cos(angle), outer_radius * np.sin(angle), 0.0], dtype=np.float64))
        masses.append(float(body_mass))

    positions = np.vstack(positions)
    masses = np.asarray(masses, dtype=np.float64)

    velocities = np.zeros_like(positions, dtype=np.float64)
    binary_speed = polygon_orbital_speed(2, inner_radius, inner_mass, softening_sq, g_const=g_const)
    if clockwise:
        velocities[0] = np.array([0.0, binary_speed, 0.0], dtype=np.float64)
        velocities[1] = np.array([0.0, -binary_speed, 0.0], dtype=np.float64)
    else:
        velocities[0] = np.array([0.0, -binary_speed, 0.0], dtype=np.float64)
        velocities[1] = np.array([0.0, binary_speed, 0.0], dtype=np.float64)

    accel = compute_softened_accelerations(positions=positions, masses=masses, softening_sq=softening_sq, g_const=g_const)
    for idx in range(2, body_count):
        x = positions[idx, 0]
        y = positions[idx, 1]
        r = np.hypot(x, y)
        if r <= 1e-12:
            continue

        radial_hat = np.array([x / r, y / r, 0.0], dtype=np.float64)
        tangential_hat = np.array([-y / r, x / r, 0.0], dtype=np.float64)
        inward_accel = -float(np.dot(accel[idx], radial_hat))
        speed = np.sqrt(max(inward_accel * r, 0.0))

        if outer_mode == "retrograde":
            sign = -1.0
        elif outer_mode == "interplay":
            sign = -1.0 if (idx - 2) % 2 else 1.0
        else:
            sign = 1.0

        if clockwise:
            sign *= -1.0

        velocities[idx] = tangential_hat * speed * sign
        if outer_mode == "interplay":
            radial_kick = 0.08 * speed * ((-1.0) ** (idx - 2))
            velocities[idx] += radial_hat * radial_kick

    speed = float(np.mean(np.linalg.norm(velocities[:, :2], axis=1)))
    positions, velocities, masses, forces, total_mass = finalize_snapshot(
        positions=positions,
        velocities=velocities,
        masses=masses,
    )
    return positions, velocities, masses, forces, speed, total_mass


def curve_figure8(theta):
    s = np.sin(theta)
    c = np.cos(theta)
    denom = 1.0 + s * s
    x = c / denom
    y = (s * c) / denom
    return np.array([x, y], dtype=np.float64)


def curve_bhh(theta):
    # BHH-inspired rosette-like choreography seed.
    x = np.cos(theta) + 0.22 * np.cos(2.0 * theta)
    y = 0.78 * np.sin(theta) - 0.31 * np.sin(2.0 * theta)
    return np.array([x, y], dtype=np.float64)


def curve_suvakov(theta):
    # Suvakov-Dmitrasinovic-inspired butterfly/moth-style seed.
    x = np.sin(theta) + 0.38 * np.sin(2.0 * theta)
    y = 0.62 * np.sin(3.0 * theta)
    return np.array([x, y], dtype=np.float64)


def curve_geometry(curve_fn, thetas, h=1e-3):
    n = len(thetas)
    positions = np.zeros((n, 2), dtype=np.float64)
    tangents = np.zeros((n, 2), dtype=np.float64)
    normals = np.zeros((n, 2), dtype=np.float64)
    curvatures = np.zeros(n, dtype=np.float64)

    for i, theta in enumerate(thetas):
        r0 = curve_fn(theta)
        rp = curve_fn(theta + h)
        rm = curve_fn(theta - h)

        d1 = (rp - rm) / (2.0 * h)
        d2 = (rp - 2.0 * r0 + rm) / (h * h)

        speed_param = max(float(np.linalg.norm(d1)), 1e-12)
        tangent = d1 / speed_param
        normal_raw = d2 - tangent * float(np.dot(d2, tangent))
        normal_norm = float(np.linalg.norm(normal_raw))
        if normal_norm <= 1e-12:
            normal = np.array([-tangent[1], tangent[0]], dtype=np.float64)
        else:
            normal = normal_raw / normal_norm

        cross = d1[0] * d2[1] - d1[1] * d2[0]
        kappa = abs(float(cross)) / max(speed_param**3, 1e-12)

        positions[i] = r0
        tangents[i] = tangent
        normals[i] = normal
        curvatures[i] = kappa

    return positions, tangents, normals, curvatures


def build_curve_choreography_snapshot(
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise,
    g_const,
    curve_fn,
    family_name,
):
    if body_count < 3:
        raise ValueError(f"{family_name} family requires at least 3 bodies")

    phase_offset = np.pi / (2.0 * body_count)
    thetas = np.linspace(0.0, 2.0 * np.pi, num=body_count, endpoint=False, dtype=np.float64) + phase_offset
    shape_pos, tangents, normals, curvatures = curve_geometry(curve_fn, thetas)

    shape_radius = float(np.max(np.linalg.norm(shape_pos, axis=1)))
    scale = radius / max(shape_radius, 1e-12)

    positions = np.zeros((body_count, 3), dtype=np.float64)
    positions[:, :2] = shape_pos * scale
    masses = np.full(body_count, body_mass, dtype=np.float64)

    accel = compute_softened_accelerations(positions=positions, masses=masses, softening_sq=softening_sq, g_const=g_const)

    kappa_scaled = curvatures / max(scale, 1e-12)
    speeds = np.zeros(body_count, dtype=np.float64)
    for i in range(body_count):
        kappa = max(float(kappa_scaled[i]), 1e-8)
        a_n = abs(float(np.dot(accel[i, :2], normals[i])))
        speeds[i] = np.sqrt(max(a_n / kappa, 0.0))

    positive = speeds[speeds > 1e-8]
    if len(positive) == 0:
        speed_fallback = polygon_orbital_speed(max(body_count, 2), max(radius, 1e-6), body_mass, softening_sq, g_const)
        speeds[:] = speed_fallback
    else:
        median_speed = float(np.median(positive))
        speeds = np.clip(speeds, 0.35 * median_speed, 2.5 * median_speed)

    velocities = np.zeros((body_count, 3), dtype=np.float64)
    sign = -1.0 if clockwise else 1.0
    velocities[:, :2] = tangents * speeds[:, None] * sign

    mean_speed = float(np.mean(np.linalg.norm(velocities[:, :2], axis=1)))
    positions, velocities, masses, forces, total_mass = finalize_snapshot(
        positions=positions,
        velocities=velocities,
        masses=masses,
    )
    return positions, velocities, masses, forces, mean_speed, total_mass


def build_figure8_snapshot(
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise=False,
    g_const=DEFAULT_G,
):
    # Preserve the exact classic 3-body seed when possible.
    if body_count == 3:
        base_positions = np.array(
            [
                [0.97000436, -0.24308753, 0.0],
                [-0.97000436, 0.24308753, 0.0],
                [0.0, 0.0, 0.0],
            ],
            dtype=np.float64,
        )
        base_velocities = np.array(
            [
                [0.4662036850, 0.4323657300, 0.0],
                [0.4662036850, 0.4323657300, 0.0],
                [-0.93240737, -0.86473146, 0.0],
            ],
            dtype=np.float64,
        )

        base_radius = float(np.max(np.linalg.norm(base_positions[:, :2], axis=1)))
        scale = radius / max(base_radius, 1e-12)
        velocity_scale = np.sqrt(max(g_const * body_mass, 0.0) / max(scale, 1e-12))

        positions = base_positions * scale
        velocities = base_velocities * velocity_scale
        if clockwise:
            positions[:, 1] *= -1.0
            velocities[:, 1] *= -1.0

        masses = np.full(3, body_mass, dtype=np.float64)
        mean_speed = float(np.mean(np.linalg.norm(velocities[:, :2], axis=1)))
        positions, velocities, masses, forces, total_mass = finalize_snapshot(
            positions=positions,
            velocities=velocities,
            masses=masses,
        )

        if softening_sq > 0.0:
            print(
                "warning: figure8 exactness is for unsoftened Newtonian gravity; "
                "non-zero softening perturbs periodicity"
            )

        return positions, velocities, masses, forces, mean_speed, total_mass

    return build_curve_choreography_snapshot(
        body_count=body_count,
        radius=radius,
        body_mass=body_mass,
        softening_sq=softening_sq,
        clockwise=clockwise,
        g_const=g_const,
        curve_fn=curve_figure8,
        family_name="figure8",
    )


def build_bhh_snapshot(
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise=False,
    g_const=DEFAULT_G,
):
    return build_curve_choreography_snapshot(
        body_count=body_count,
        radius=radius,
        body_mass=body_mass,
        softening_sq=softening_sq,
        clockwise=clockwise,
        g_const=g_const,
        curve_fn=curve_bhh,
        family_name="bhh",
    )


def build_suvakov_dmitrasinovic_snapshot(
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise=False,
    g_const=DEFAULT_G,
):
    return build_curve_choreography_snapshot(
        body_count=body_count,
        radius=radius,
        body_mass=body_mass,
        softening_sq=softening_sq,
        clockwise=clockwise,
        g_const=g_const,
        curve_fn=curve_suvakov,
        family_name="suvakov-dmitrasinovic",
    )


def resolve_family_for_body_count(family, body_count):
    if family == "auto":
        if body_count == 3:
            return "figure8"
        if body_count >= 96:
            return "multiring"
        if body_count >= 12:
            return "hierarchical"
        return "polygon"
    return family


def build_snapshot_for_family(
    family,
    body_count,
    radius,
    body_mass,
    softening_sq,
    clockwise,
    g_const,
    wheel_center_mass_multiplier,
):
    family = resolve_family_for_body_count(family, body_count)

    if family == "polygon":
        return build_stable_polygon_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
        ), family
    if family == "multiring":
        return build_multiring_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
        ), family
    if family == "wheel":
        return build_wheel_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
            center_mass_multiplier=wheel_center_mass_multiplier,
        ), family
    if family == "hierarchical":
        return build_hierarchical_binary_tertiary_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
            outer_mode="prograde",
        ), family
    if family == "retrograde":
        return build_hierarchical_binary_tertiary_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
            outer_mode="retrograde",
        ), family
    if family == "interplay":
        return build_hierarchical_binary_tertiary_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
            outer_mode="interplay",
        ), family
    if family == "lagrange-3":
        return build_lagrange_3_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
        ), family
    if family == "euler-3":
        return build_euler_3_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
        ), family
    if family == "figure8":
        return build_figure8_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
        ), family
    if family == "bhh":
        return build_bhh_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
        ), family
    if family == "suvakov-dmitrasinovic":
        return build_suvakov_dmitrasinovic_snapshot(
            body_count=body_count,
            radius=radius,
            body_mass=body_mass,
            softening_sq=softening_sq,
            clockwise=clockwise,
            g_const=g_const,
        ), family

    raise ValueError(f"unsupported family {family!r}")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate stable multi-family orbital snapshots in AGM1 binary format"
    )
    parser.add_argument(
        "--bodies",
        type=int,
        default=None,
        help="number of bodies in the system (no hard upper lock)",
    )
    parser.add_argument(
        "--family",
        type=str,
        default="auto",
        help=(
            "orbit family: auto, polygon, multiring, wheel, hierarchical, bhh, "
            "suvakov-dmitrasinovic, retrograde, interplay, figure8, lagrange-3, euler-3"
        ),
    )
    parser.add_argument(
        "--list-families",
        action="store_true",
        help="print available family names and exit",
    )
    parser.add_argument(
        "--radius",
        type=float,
        default=None,
        help="base orbit radius (default scales with body count)",
    )
    parser.add_argument(
        "--body-mass",
        type=float,
        default=DEFAULT_BODY_MASS,
        help="mass of each body",
    )
    parser.add_argument(
        "--softening-sq",
        type=float,
        default=DEFAULT_SOFTENING_SQ,
        help="softening^2 used for speed calculation (match backend SOFTENING_SQ)",
    )
    parser.add_argument(
        "--g",
        type=float,
        default=DEFAULT_G,
        help="gravitational constant used for speed calculation (match backend G_CONST)",
    )
    parser.add_argument(
        "--clockwise",
        action="store_true",
        help="orbit clockwise instead of counterclockwise",
    )
    parser.add_argument(
        "--wheel-center-mass-multiplier",
        type=float,
        default=2.5,
        help="center mass multiplier used by wheel family",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=str(Path(__file__).with_name("galaxy.bin")),
        help="output binary snapshot path",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    if args.list_families:
        print("Available families:")
        for name in AVAILABLE_FAMILIES:
            print(f"  - {name}")
        return

    if args.bodies is None:
        raise ValueError("--bodies is required unless --list-families is used")

    if args.bodies < 2:
        raise ValueError("--bodies must be >= 2")

    family = canonical_family_name(args.family)
    radius = args.radius if args.radius is not None else default_radius_for_count(args.bodies)
    if radius <= 0.0:
        raise ValueError("radius must be > 0")

    snapshot, resolved_family = build_snapshot_for_family(
        family=family,
        body_count=args.bodies,
        radius=radius,
        body_mass=args.body_mass,
        softening_sq=args.softening_sq,
        clockwise=args.clockwise,
        g_const=args.g,
        wheel_center_mass_multiplier=args.wheel_center_mass_multiplier,
    )
    positions, velocities, masses, forces, speed, total_mass = snapshot

    write_agama_binary_snapshot(
        output_path=args.out,
        positions=positions,
        velocities=velocities,
        masses=masses,
        forces=forces,
    )

    direction = "clockwise" if args.clockwise else "counterclockwise"
    print("--- Stable Orbit Snapshot Generation Complete ---")
    print(f"Family:               {resolved_family}")
    print(f"Bodies:               {args.bodies}")
    print(f"Radius:               {radius:.3f}")
    print(f"Body mass:            {args.body_mass:.3f}")
    print(f"Total mass:           {total_mass:.3f}")
    print(f"Mean speed magnitude: {speed:.6f}")
    print(f"Softening^2:          {args.softening_sq:.6f}")
    print(f"G:                    {args.g:.6f}")
    print(f"Rotation:             {direction}")
    print(f"Output:               {args.out}")


if __name__ == "__main__":
    main()
