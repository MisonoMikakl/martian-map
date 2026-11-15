# planner.py
# B模块：路径规划、目标点排序、返回安全场、路线 JSON
#
# 内部约定：
# - graph 边权单位：秒
# - 对外 JSON 时间单位：分钟
# - 节点编号：idx = y * width + x
# - 路径坐标格式：[x, y, cumulative_minutes]
#
# TODO[C]：
# 1. 确认 C 是否直接读取本文件生成的 JSON 字段。
# 2. 确认 C 对 order 中 START / hab 的展示方式。
# 3. 确认 C 对 unsafe、error、envelope_frames 的展示逻辑。


import numpy as np
from scipy.sparse.csgraph import dijkstra
from itertools import permutations


def _validate_graph(graph, width, height):
    n = int(width) * int(height)

    if graph.shape != (n, n):
        raise ValueError(
            f"graph shape={graph.shape}，"
            f"但 width*height={n}"
        )


def _validate_node_index(idx, n_nodes, name="node"):
    idx = int(idx)
    if idx < 0 or idx >= n_nodes:
        raise ValueError(
            f"{name} index={idx} 超出合法范围 [0, {n_nodes - 1}]"
        )
    return idx


def run_dijkstra(graph, start_idx):
    """从 start_idx 计算单源最短路径，距离单位秒。"""
    n_nodes = graph.shape[0]
    start_idx = _validate_node_index(
        start_idx, n_nodes, "start_idx"
    )

    dist, prev = dijkstra(
        graph,
        directed=True,
        indices=start_idx,
        return_predecessors=True,
    )

    return dist, prev


def get_return_field(graph, hab_idx):
    """
    计算每个格子返回 Habitat 的最短时间，单位秒。

    原图中：
        i -> hab

    转置图中：
        hab -> i

    因此在 graph.T 上从 hab_idx 做单源 Dijkstra，
    得到的 dist[i] 就是原图 i 返回 hab 的最短时间。
    """
    n_nodes = graph.shape[0]
    hab_idx = _validate_node_index(
        hab_idx, n_nodes, "hab_idx"
    )

    dist = dijkstra(
        graph.T.tocsr(),
        directed=True,
        indices=hab_idx,
        return_predecessors=False,
    )

    return np.asarray(dist)


def extract_path(prev, start_idx, end_idx):
    """
    根据 SciPy Dijkstra 的 predecessors 数组恢复路径。

    SciPy 对无前驱节点通常使用 -9999。
    如果路径不可达或前驱数组异常，返回 []。
    """
    prev = np.asarray(prev)
    n_nodes = len(prev)

    if n_nodes == 0:
        return []

    if not (0 <= start_idx < n_nodes):
        return []

    if not (0 <= end_idx < n_nodes):
        return []

    if start_idx == end_idx:
        return [int(start_idx)]

    path = []
    current = int(end_idx)

    for _ in range(n_nodes):
        if current == start_idx:
            path.append(current)
            path.reverse()
            return path

        if current < 0 or current >= n_nodes:
            return []

        path.append(current)

        parent = int(prev[current])

        # -9999 表示没有前驱，说明路径无法回溯到起点。
        if parent < 0:
            return []

        current = parent

    # 超过节点数仍未到达起点，视为异常循环。
    return []


def _prepare_nodes(
    start_idx,
    wp_dict,
    target_ids,
    hab_idx,
    params,
):
    width = int(params["width"])
    height = int(params["height"])
    n_nodes = width * height

    nodes = [
        {
            "id": "START",
            "idx": _validate_node_index(
                start_idx, n_nodes, "start_idx"
            ),
            "dwell": 0.0,
            "priority": 0.0,
        }
    ]

    if len(set(target_ids)) != len(target_ids):
        raise ValueError("target_ids 中存在重复 ID")

    for target_id in target_ids:
        if target_id not in wp_dict:
            raise ValueError(
                f"waypoint 数据中不存在目标点: {target_id}"
            )

        waypoint = wp_dict[target_id]

        if "x" not in waypoint or "y" not in waypoint:
            raise ValueError(
                f"目标点 {target_id} 缺少 x 或 y 坐标"
            )

        x = int(waypoint["x"])
        y = int(waypoint["y"])

        if not (0 <= x < width and 0 <= y < height):
            raise ValueError(
                f"目标点 {target_id} 坐标越界: ({x}, {y})"
            )

        dwell = float(waypoint.get("dwell_min", 0))
        priority = float(waypoint.get("priority", 0))

        if not np.isfinite(dwell) or dwell < 0:
            raise ValueError(
                f"目标点 {target_id} dwell_min 不合法"
            )

        if not np.isfinite(priority):
            raise ValueError(
                f"目标点 {target_id} priority 不合法"
            )

        nodes.append(
            {
                "id": str(target_id),
                "idx": y * width + x,
                "dwell": dwell,
                "priority": priority,
            }
        )

    nodes.append(
        {
            "id": "hab",
            "idx": _validate_node_index(
                hab_idx, n_nodes, "hab_idx"
            ),
            "dwell": 0.0,
            "priority": 0.0,
        }
    )

    return nodes


def plan_tsp(
    graph,
    start_idx,
    wp_dict,
    target_ids,
    hab_idx,
    params,
    elapsed_min=0,
):
    """
    对最多 5 个目标点进行子集 + 排列枚举。

    优先级排序规则：
    1. 总 priority 更高
    2. 访问目标点数量更多
    3. 总耗时更短

    时间预算：
        eva_budget_min
        - reserve_min
        - elapsed_min

    返回：
        best_order, dist_matrix, prev_matrix, nodes, dropped
    """
    width = int(params["width"])
    height = int(params["height"])
    _validate_graph(graph, width, height)

    if len(target_ids) > 5:
        raise ValueError(
            "当前 TSP 枚举实现最多支持 5 个目标点"
        )

    elapsed_min = float(elapsed_min)
    eva_budget_min = float(params["eva_budget_min"])
    reserve_min = float(params["reserve_min"])

    if not np.isfinite(elapsed_min) or elapsed_min < 0:
        raise ValueError("elapsed_min 必须为非负有限数")

    if (
        not np.isfinite(eva_budget_min)
        or not np.isfinite(reserve_min)
        or eva_budget_min <= 0
        or reserve_min < 0
    ):
        raise ValueError("EVA 预算参数不合法")

    nodes = _prepare_nodes(
        start_idx,
        wp_dict,
        target_ids,
        hab_idx,
        params,
    )

    n = len(nodes)
    dist_matrix = np.full(
        (n, n),
        np.inf,
        dtype=np.float64,
    )

    prev_matrix = {}

    # 每个节点运行一次 Dijkstra。
    # 目标点数量较少时，这种方式便于保存每段路径的前驱数组。
    for i in range(n):
        dist_arr, prev_arr = run_dijkstra(
            graph,
            nodes[i]["idx"],
        )

        for j in range(n):
            if i == j:
                dist_matrix[i, j] = 0.0
                continue

            seconds = dist_arr[nodes[j]["idx"]]

            if np.isfinite(seconds):
                dist_matrix[i, j] = seconds / 60.0
                prev_matrix[(i, j)] = prev_arr

    available_time = (
        eva_budget_min
        - reserve_min
        - elapsed_min
    )

    best_order = []
    best_priority = -np.inf
    best_count = -1
    best_time = np.inf

    target_indices = list(range(1, n - 1))

    # 先尝试访问更多目标点，再逐渐减少目标点数量。
    for count_to_visit in range(len(target_indices), -1, -1):
        for perm in permutations(
            target_indices,
            count_to_visit,
        ):
            full_order = (
                [0]
                + list(perm)
                + [n - 1]
            )

            total_time = 0.0
            possible = True

            priority_sum = sum(
                nodes[i]["priority"]
                for i in perm
            )

            for pos in range(len(full_order) - 1):
                u = full_order[pos]
                v = full_order[pos + 1]

                travel_time = dist_matrix[u, v]

                if not np.isfinite(travel_time):
                    possible = False
                    break

                total_time += travel_time
                total_time += nodes[v]["dwell"]

            if not possible or total_time > available_time:
                continue

            visited_count = len(perm)

            is_better = (
                priority_sum > best_priority
                or (
                    priority_sum == best_priority
                    and visited_count > best_count
                )
                or (
                    priority_sum == best_priority
                    and visited_count == best_count
                    and total_time < best_time
                )
            )

            if is_better:
                best_order = full_order
                best_priority = priority_sum
                best_count = visited_count
                best_time = total_time

    if not best_order:
        dropped = [
            nodes[i]["id"]
            for i in target_indices
        ]

        return (
            [],
            dist_matrix,
            prev_matrix,
            nodes,
            dropped,
        )

    visited = set(best_order)

    dropped = [
        nodes[i]["id"]
        for i in target_indices
        if i not in visited
    ]

    return (
        best_order,
        dist_matrix,
        prev_matrix,
        nodes,
        dropped,
    )


def build_route_json(
    graph,
    best_order,
    dist_matrix,
    prev_matrix,
    nodes,
    dropped,
    params,
    elevation,
    return_field_sec,
    elapsed_min,
    scenario_id,
    title,
):
    """
    将规划结果转为 C 模块使用的 JSON 数据结构。

    path:
        [[x, y, cumulative_minutes], ...]

    profile:
        [{"d_m": ..., "elev_m": ..., "slope_deg": ..., "t_min": ...}, ...]

    legs:
        每段路线的起终点、耗时、距离、最大坡度及停留时间。
    """
    width = int(params["width"])
    height = int(params["height"])
    res_m = float(params["res_m"])

    elevation = np.asarray(elevation, dtype=np.float64)
    return_field_sec = np.asarray(
        return_field_sec,
        dtype=np.float64,
    )

    _validate_graph(graph, width, height)

    if elevation.shape != (height, width):
        raise ValueError("elevation shape 与地图尺寸不一致")

    if len(return_field_sec) != width * height:
        raise ValueError("return_field_sec 长度与地图尺寸不一致")

    route = {
        "id": str(scenario_id),
        "title": str(title),
        "params": {
            key: params[key]
            for key in (
                "k",
                "alpha",
                "max_slope_deg",
                "eva_budget_min",
                "reserve_min",
            )
            if key in params
        },
        "event": None,
        "order": [],
        "dropped": list(dropped),
        "path": [],
        "legs": [],
        "profile": [],
        "envelope_frames": [],
        "unsafe": [],
    }

    if not best_order:
        route["error"] = (
            "Unreachable: Cannot find a safe path "
            "returning to Habitat within budget."
        )
        return route

    if len(best_order) < 2:
        route["error"] = "Invalid route: insufficient route nodes."
        return route

    current_cum_min = float(elapsed_min)
    accumulated_distance = 0.0

    time_limit = (
        float(params["eva_budget_min"])
        - float(params["reserve_min"])
    )

    flat_elevation = elevation.ravel()

    start_idx = nodes[best_order[0]]["idx"]
    start_x = start_idx % width
    start_y = start_idx // width

    route["path"].append(
        [
            int(start_x),
            int(start_y),
            float(current_cum_min),
        ]
    )

    route["profile"].append(
        {
            "d_m": 0.0,
            "elev_m": float(flat_elevation[start_idx]),
            "slope_deg": 0.0,
            "t_min": float(current_cum_min),
        }
    )

    # 起点也需要检查返回安全性。
    if (
        not np.isfinite(return_field_sec[start_idx])
        or current_cum_min + return_field_sec[start_idx] / 60.0
        > time_limit
    ):
        route["unsafe"].append(
            [int(start_x), int(start_y)]
        )

    for leg_position in range(len(best_order) - 1):
        u_node_position = best_order[leg_position]
        v_node_position = best_order[leg_position + 1]

        u_node = nodes[u_node_position]
        v_node = nodes[v_node_position]

        u_idx = int(u_node["idx"])
        v_idx = int(v_node["idx"])

        prev = prev_matrix.get(
            (u_node_position, v_node_position)
        )

        if prev is None:
            route["error"] = (
                f"Missing predecessor data for "
                f"{u_node['id']} -> {v_node['id']}"
            )
            return route

        path_indices = extract_path(
            prev,
            u_idx,
            v_idx,
        )

        if not path_indices:
            route["error"] = (
                f"Path reconstruction failed for "
                f"{u_node['id']} -> {v_node['id']}"
            )
            return route

        leg_distance = 0.0
        leg_max_slope = 0.0
        leg_start_time = current_cum_min

        for j, idx in enumerate(path_indices):
            idx = int(idx)

            if j == 0:
                # 第一段起点已经加入 path。
                # 后续段起点是上一段的终点，也已经加入 path。
                continue

            previous_idx = int(path_indices[j - 1])

            x = idx % width
            y = idx // width

            previous_x = previous_idx % width
            previous_y = previous_idx // width

            dx = abs(x - previous_x)
            dy = abs(y - previous_y)

            if dx > 1 or dy > 1 or (dx == 0 and dy == 0):
                route["error"] = (
                    f"Invalid adjacent path nodes: "
                    f"{previous_idx} -> {idx}"
                )
                return route

            edge_seconds = float(
                graph[previous_idx, idx]
            )

            if (
                not np.isfinite(edge_seconds)
                or edge_seconds <= 0
            ):
                route["error"] = (
                    f"Invalid edge weight: "
                    f"{previous_idx} -> {idx}"
                )
                return route

            current_cum_min += edge_seconds / 60.0

            step_distance = (
                res_m * np.sqrt(2.0)
                if dx == 1 and dy == 1
                else res_m
            )

            leg_distance += step_distance
            accumulated_distance += step_distance

            dz = (
                flat_elevation[idx]
                - flat_elevation[previous_idx]
            )

            slope_deg = float(
                np.degrees(
                    np.arctan(abs(dz / step_distance))
                )
            )

            leg_max_slope = max(
                leg_max_slope,
                slope_deg,
            )

            route["path"].append(
                [
                    int(x),
                    int(y),
                    float(current_cum_min),
                ]
            )

            route["profile"].append(
                {
                    "d_m": float(accumulated_distance),
                    "elev_m": float(flat_elevation[idx]),
                    "slope_deg": slope_deg,
                    "t_min": float(current_cum_min),
                }
            )

            return_seconds = return_field_sec[idx]

            if (
                not np.isfinite(return_seconds)
                or (
                    current_cum_min + return_seconds / 60.0
                    > time_limit
                )
            ):
                route["unsafe"].append(
                    [int(x), int(y)]
                )

        arrival_time = current_cum_min

        dwell_min = float(v_node["dwell"])
        current_cum_min += dwell_min

        departure_time = current_cum_min

        # 停留结束后再次检查该位置的返回安全性。
        if dwell_min > 0:
            return_seconds = return_field_sec[v_idx]

            if (
                not np.isfinite(return_seconds)
                or (
                    current_cum_min + return_seconds / 60.0
                    > time_limit
                )
            ):
                target_x = v_idx % width
                target_y = v_idx // width

                route["unsafe"].append(
                    [int(target_x), int(target_y)]
                )

        route["legs"].append(
            {
                "from": str(u_node["id"]),
                "to": str(v_node["id"]),
                "time_min": float(
                    dist_matrix[
                        u_node_position,
                        v_node_position,
                    ]
                ),
                "dist_m": float(leg_distance),
                "max_slope_deg": float(leg_max_slope),
                "dwell_min": float(dwell_min),
                "arrival_min": float(arrival_time),
                "departure_min": float(departure_time),
            }
        )

        route["order"].append(str(u_node["id"]))

    route["order"].append(
        str(nodes[best_order[-1]]["id"])
    )

    route["total_time_min"] = float(
        current_cum_min - elapsed_min
    )
    route["elapsed_time_min"] = float(current_cum_min)
    route["total_distance_m"] = float(accumulated_distance)

    # 去重，但保留第一次出现的顺序。
    route["unsafe"] = [
        list(item)
        for item in dict.fromkeys(
            tuple(item) for item in route["unsafe"]
        )
    ]

    return route


def plan_route(
    graph,
    start_idx,
    wp_dict,
    target_ids,
    hab_idx,
    params,
    elevation,
    scenario_id="nominal",
    title="Nominal",
    elapsed_min=0.0,
):
    """
    一次性执行：
    1. 计算 Return Field
    2. TSP 目标点排序
    3. 生成路线 JSON
    """
    return_field = get_return_field(
        graph,
        hab_idx,
    )

    (
        best_order,
        dist_matrix,
        prev_matrix,
        nodes,
        dropped,
    ) = plan_tsp(
        graph=graph,
        start_idx=start_idx,
        wp_dict=wp_dict,
        target_ids=target_ids,
        hab_idx=hab_idx,
        params=params,
        elapsed_min=elapsed_min,
    )

    route = build_route_json(
        graph=graph,
        best_order=best_order,
        dist_matrix=dist_matrix,
        prev_matrix=prev_matrix,
        nodes=nodes,
        dropped=dropped,
        params=params,
        elevation=elevation,
        return_field_sec=return_field,
        elapsed_min=elapsed_min,
        scenario_id=scenario_id,
        title=title,
    )

    return route, return_field