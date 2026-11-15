
import numpy as np
from scipy.sparse import csr_matrix


def build_graph(grid_meta, elevation, rough, hazard, params):
    """
    构建8邻域有向CSR图。
    边权单位：秒。
    假设 hazard=1 表示障碍，hazard=0 表示可通行。
    """

    width = grid_meta["width"]
    height = grid_meta["height"]
    res_m = grid_meta["res_m"]

    k = params["k"]
    alpha = params["alpha"]
    max_slope_deg = params["max_slope_deg"]

    # 1. 参数检查
    if width <= 0 or height <= 0:
        raise ValueError("Invalid grid dimensions")

    if res_m <= 0 or k <= 0:
        raise ValueError("res_m and k must be positive")

    if alpha < 0:
        raise ValueError("alpha cannot be negative")

    if not 0 <= max_slope_deg < 90:
        raise ValueError("Invalid max_slope_deg")

    # 2. 输入数组检查
    elevation = np.asarray(elevation)
    rough = np.asarray(rough)
    hazard = np.asarray(hazard)

    expected_shape = (height, width)

    if elevation.shape != expected_shape:
        raise ValueError("Elevation shape mismatch")

    if rough.shape != expected_shape:
        raise ValueError("Roughness shape mismatch")

    if hazard.shape != expected_shape:
        raise ValueError("Hazard shape mismatch")

    N = width * height

    # 3. 统一有效格点掩码
    cell_valid = (
        (hazard != 1) &
        np.isfinite(elevation) &
        np.isfinite(rough) &
        (rough >= 0)
    )

    # 4. 八邻域方向
    directions = [
        (1, 0, False), (-1, 0, False),
        (0, 1, False), (0, -1, False),
        (1, 1, True), (1, -1, True),
        (-1, 1, True), (-1, -1, True)
    ]

    y, x = np.mgrid[0:height, 0:width]

    rows, cols, data = [], [], []

    for dx, dy, is_diag in directions:

        vx = x + dx
        vy = y + dy

        # 边界检查
        valid = (
            (vx >= 0) & (vx < width) &
            (vy >= 0) & (vy < height)
        )

        # 防止越界访问
        safe_vx = np.where(valid, vx, 0)
        safe_vy = np.where(valid, vy, 0)

        # 起点和目标点必须有效
        valid &= (
            cell_valid[y, x] &
            cell_valid[safe_vy, safe_vx]
        )

        # 对角线禁止切角
        if is_diag:
            valid &= (
                cell_valid[y, safe_vx] &
                cell_valid[safe_vy, x]
            )

        # 提取有效边的起点和终点
        u_valid = y[valid] * width + x[valid]
        v_valid = safe_vy[valid] * width + safe_vx[valid]

        z_u = elevation[y[valid], x[valid]]
        z_v = elevation[safe_vy[valid], safe_vx[valid]]
        r_v = rough[safe_vy[valid], safe_vx[valid]]

        dist_m = res_m * np.sqrt(2) if is_diag else res_m

        # 5. 坡度计算
        g_uv = (z_v - z_u) / dist_m

        slope_deg = np.degrees(
            np.arctan(np.abs(g_uv))
        )

        valid_slope = slope_deg <= max_slope_deg

        u_valid = u_valid[valid_slope]
        v_valid = v_valid[valid_slope]
        g_uv = g_uv[valid_slope]
        r_v = r_v[valid_slope]

        # 6. Tobler 徒步模型
        v_T = 6 * np.exp(
            -3.5 * np.abs(g_uv + 0.05)
        )

        time_sec = (
            (dist_m / 1000) / (k * v_T)
        ) * 3600

        time_sec *= (1 + alpha * r_v)

        # 7. 最终边权检查
        valid_cost = (
            np.isfinite(time_sec) &
            (time_sec > 0)
        )

        u_valid = u_valid[valid_cost]
        v_valid = v_valid[valid_cost]
        time_sec = time_sec[valid_cost]

        rows.append(u_valid)
        cols.append(v_valid)
        data.append(time_sec)

    # 8. 构建 CSR 图
    return csr_matrix(
        (
            np.concatenate(data).astype(np.float32),
            (
                np.concatenate(rows),
                np.concatenate(cols)
            )
        ),
        shape=(N, N),
        dtype=np.float32
    )
