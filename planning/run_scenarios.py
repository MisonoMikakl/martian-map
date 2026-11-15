
import argparse
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image

from build_graph import build_graph
from planner import (
    get_return_field,
    plan_tsp,
    build_route_json,
)


# =========================================================
# 1. 配置与数据读取
# =========================================================

def read_json(path):
    """读取 JSON 文件。"""
    path = Path(path)

    if not path.exists():
        raise FileNotFoundError(f"找不到 JSON 文件: {path}")

    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_grid_data(data_dir):
    """
    读取 A 模块提供的真实栅格数据。

    默认文件结构：
        data_dir/
            grid.json
            elevation.bin
            rough.bin
            hazard.bin

    当前 BIN 格式约定：
        elevation: little-endian float32
        rough:     little-endian float32
        hazard:    uint8

    TODO[A]：
    1. 确认 BIN 是否为 little-endian。
    2. 确认是否为 row-major 存储。
    3. 确认是否存在文件头或其他元数据。
    4. 确认 hazard == 1 是否表示不可通行。
    5. 确认 NoData 编码方式。
    """

    data_dir = Path(data_dir)

    grid_meta = read_json(data_dir / "grid.json")

    required_fields = ["width", "height", "res_m"]

    for key in required_fields:
        if key not in grid_meta:
            raise ValueError(
                f"grid.json 缺少必要字段: {key}"
            )

    width = int(grid_meta["width"])
    height = int(grid_meta["height"])
    res_m = float(grid_meta["res_m"])

    if width <= 0 or height <= 0:
        raise ValueError("地图宽度和高度必须为正数")

    if not np.isfinite(res_m) or res_m <= 0:
        raise ValueError("res_m 必须为有限正数")

    def read_bin(filename, dtype):
        file_path = data_dir / filename

        if not file_path.exists():
            raise FileNotFoundError(
                f"缺少 A 模块数据文件: {file_path}"
            )

        array = np.fromfile(file_path, dtype=dtype)

        expected_size = width * height

        if array.size != expected_size:
            raise ValueError(
                f"{filename} 数据量错误："
                f"实际 {array.size}，"
                f"预期 {expected_size}"
            )

        return array.reshape((height, width))

    print(f"Reading real grid data from: {data_dir}")

    elevation = read_bin(
        "elevation.bin",
        dtype="<f4",
    )

    rough = read_bin(
        "rough.bin",
        dtype="<f4",
    )

    hazard = read_bin(
        "hazard.bin",
        dtype=np.uint8,
    )

    print(f"Grid size: {width} x {height}")
    print(f"Resolution: {res_m} m")
    print(f"Hazard values: {np.unique(hazard)}")

    return grid_meta, elevation, rough, hazard


def load_waypoints(path):
    """
    读取 Habitat 和目标点配置。

    推荐格式：

    {
        "habitat": {
            "x": 100,
            "y": 100
        },
        "waypoints": {
            "t1": {
                "x": 200,
                "y": 200,
                "dwell_min": 15,
                "priority": 1
            },
            "t2": {
                "x": 800,
                "y": 800,
                "dwell_min": 30,
                "priority": 2
            }
        }
    }

    也支持 waypoints 使用 list 的格式：

    {
        "habitat": {"x": 100, "y": 100},
        "waypoints": [
            {"id": "t1", "x": 200, "y": 200}
        ]
    }

    TODO[D/A]：与任务点配置负责人确认最终字段名称。
    """

    data = read_json(path)

    if "habitat" not in data:
        raise ValueError(
            "waypoints.json 缺少 habitat 字段"
        )

    habitat = data["habitat"]

    if "x" not in habitat or "y" not in habitat:
        raise ValueError(
            "habitat 必须包含 x 和 y"
        )

    raw_waypoints = data.get("waypoints")

    if raw_waypoints is None:
        raise ValueError(
            "waypoints.json 缺少 waypoints 字段"
        )

    if isinstance(raw_waypoints, dict):

        wp_dict = {
            str(key): value
            for key, value in raw_waypoints.items()
        }

    elif isinstance(raw_waypoints, list):

        wp_dict = {}

        for item in raw_waypoints:
            if "id" not in item:
                raise ValueError(
                    "waypoint 列表中的每个点都必须包含 id"
                )

            wp_id = str(item["id"])

            if wp_id in wp_dict:
                raise ValueError(
                    f"waypoint ID 重复: {wp_id}"
                )

            wp_dict[wp_id] = item

    else:
        raise ValueError(
            "waypoints 必须是 dict 或 list"
        )

    target_ids = list(wp_dict.keys())

    for target_id, point in wp_dict.items():

        if "x" not in point or "y" not in point:
            raise ValueError(
                f"目标点 {target_id} 缺少 x 或 y"
            )

    return habitat, wp_dict, target_ids


def load_env(path, grid_meta):
    """
    读取规划参数。

    如果 env.json 中没有某个参数，
    暂时使用当前项目原代码中的默认值。

    TODO[B]：最终确定参数取值和物理含义。
    """

    params = {
        "k": 0.6,
        "alpha": 0.5,
        "max_slope_deg": 15.0,
        "eva_budget_min": 240.0,
        "reserve_min": 30.0,

        # 事件参数
        "slow_k_factor": 0.8,
        "dust_budget_min": 180.0,
    }

    if path and Path(path).exists():
        env_data = read_json(path)
        params.update(env_data)

    # 从 A 的 grid.json 获取地图参数。
    params["width"] = int(grid_meta["width"])
    params["height"] = int(grid_meta["height"])
    params["res_m"] = float(grid_meta["res_m"])

    # 参数检查。
    for key in [
        "k",
        "alpha",
        "max_slope_deg",
        "eva_budget_min",
        "reserve_min",
        "slow_k_factor",
        "dust_budget_min",
    ]:
        value = float(params[key])

        if not np.isfinite(value):
            raise ValueError(f"参数 {key} 不是有效数值")

        params[key] = value

    if params["k"] <= 0:
        raise ValueError("k 必须大于 0")

    if params["alpha"] < 0:
        raise ValueError("alpha 不能小于 0")

    if not 0 < params["max_slope_deg"] < 90:
        raise ValueError("max_slope_deg 必须在 0 到 90 之间")

    if params["eva_budget_min"] <= 0:
        raise ValueError("eva_budget_min 必须大于 0")

    if params["reserve_min"] < 0:
        raise ValueError("reserve_min 不能小于 0")

    if params["slow_k_factor"] <= 0:
        raise ValueError("slow_k_factor 必须大于 0")

    if params["dust_budget_min"] <= 0:
        raise ValueError("dust_budget_min 必须大于 0")

    return params


# =========================================================
# 2. 坐标与任务点检查
# =========================================================

def xy_to_idx(x, y, width, height):
    """二维坐标转一维节点编号。"""

    x = int(x)
    y = int(y)

    if not (0 <= x < width and 0 <= y < height):
        raise ValueError(
            f"坐标 ({x}, {y}) 超出地图范围"
        )

    return y * width + x


def validate_locations(
    habitat,
    wp_dict,
    elevation,
    rough,
    hazard,
):
    """
    检查 Habitat 和所有目标点是否落在有效格子上。

    当前沿用 hazard == 1 表示不可通行的约定。

    TODO[A]：确认危险区域编码和 NoData 规范。
    """

    height, width = elevation.shape

    locations = {
        "habitat": habitat,
        **wp_dict,
    }

    for name, point in locations.items():

        x = int(point["x"])
        y = int(point["y"])

        if not (0 <= x < width and 0 <= y < height):
            raise ValueError(
                f"{name} 坐标 ({x}, {y}) 超出地图范围"
            )

        if hazard[y, x] == 1:
            raise ValueError(
                f"{name} 位于不可通行区域"
            )

        if not np.isfinite(elevation[y, x]):
            raise ValueError(
                f"{name} 所在位置的 elevation 无效"
            )

        if (
            not np.isfinite(rough[y, x])
            or rough[y, x] < 0
        ):
            raise ValueError(
                f"{name} 所在位置的 rough 数据无效"
            )


# =========================================================
# 3. 事件位置与剩余目标点
# =========================================================

def get_position_at_time(route_json, target_time_min):
    """
    从 Nominal 计划路径中获取事件发生时的实际位置。

    path 格式：
        [x, y, cumulative_minutes]

    当事件发生在两个离散路径点之间时，
    使用事件时间之前最后一个已到达的栅格点。

    如果事件发生在目标点停留期间，
    由于 path 不会在停留过程中增加新点，
    这里仍会返回目标点所在位置。
    """

    path = route_json.get("path", [])

    if not path:
        raise ValueError(
            "Nominal route path is empty"
        )

    target_time_min = float(target_time_min)

    if target_time_min < 0:
        raise ValueError(
            "事件时间不能小于 0"
        )

    last_time = float(path[-1][2])

    if target_time_min > last_time:
        raise ValueError(
            f"事件时间 {target_time_min} min "
            f"超过 Nominal 路线最后一个路径点时间 {last_time} min"
        )

    selected = path[0]

    for point in path:

        if float(point[2]) <= target_time_min:
            selected = point
        else:
            break

    return (
        int(selected[0]),
        int(selected[1]),
    )


def get_remaining_targets(
    nominal_route,
    target_ids,
    wp_dict,
    event_time_min,
):
    """
    根据 Nominal 路线的 arrival_min / departure_min，
    判断事件发生后哪些目标点尚未完成。

    规则：

    1. departure_min <= event_time_min：
       目标点已经完成，不再访问。

    2. arrival_min <= event_time_min < departure_min：
       事件发生在目标点停留期间。
       目标点仍然保留，但只计算剩余停留时间。

    3. arrival_min > event_time_min：
       目标点尚未抵达，保留完整 dwell_min。

    4. 没有出现在 Nominal order 中的目标点：
       仍作为未访问目标点保留。

    返回：
        remaining_target_ids
        replanning_wp_dict
    """

    event_time_min = float(event_time_min)

    replanning_wp_dict = {
        key: dict(value)
        for key, value in wp_dict.items()
    }

    completed = set()

    for leg in nominal_route.get("legs", []):

        target_id = leg.get("to")

        if target_id not in target_ids:
            continue

        arrival_min = float(
            leg.get("arrival_min", np.inf)
        )

        departure_min = float(
            leg.get("departure_min", np.inf)
        )

        if departure_min <= event_time_min:

            completed.add(target_id)

        elif arrival_min <= event_time_min < departure_min:

            # 事件发生在当前目标点停留期间。
            # 只保留剩余停留时间，避免重复计算。
            remaining_dwell = max(
                0.0,
                departure_min - event_time_min,
            )

            replanning_wp_dict[target_id]["dwell_min"] = (
                remaining_dwell
            )

    remaining_target_ids = [
        target_id
        for target_id in target_ids
        if target_id not in completed
    ]

    return (
        remaining_target_ids,
        replanning_wp_dict,
    )


# =========================================================
# 4. 安全范围 PNG 输出
# =========================================================

def save_png_frame(
    return_field_sec,
    width,
    height,
    time_limit_min,
    current_min,
    filename,
):
    """
    根据 Return Field 生成安全范围透明 PNG。

    判断条件：

        return_time + current_time
        <= eva_budget_min - reserve_min

    安全区域：
        RGBA = [255, 50, 50, 100]

    其他区域：
        完全透明。

    TODO[C]：
    1. 确认 PNG 颜色和透明度。
    2. 确认 C 端地图坐标方向是否需要上下翻转。
    """

    return_field_sec = np.asarray(
        return_field_sec,
        dtype=np.float64,
    )

    if return_field_sec.size != width * height:
        raise ValueError(
            "Return Field 长度与地图尺寸不一致"
        )

    remaining_time_sec = (
        float(time_limit_min)
        - float(current_min)
    ) * 60.0

    valid_mask = (
        np.isfinite(return_field_sec)
        & (return_field_sec >= 0)
        & (return_field_sec <= remaining_time_sec)
    )

    valid_mask = valid_mask.reshape(
        (height, width)
    )

    rgba = np.zeros(
        (height, width, 4),
        dtype=np.uint8,
    )

    rgba[valid_mask] = [
        255,
        50,
        50,
        100,
    ]

    filename = Path(filename)

    filename.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    Image.fromarray(
        rgba,
    ).save(filename)

    return filename.name


# =========================================================
# 5. JSON 输出
# =========================================================

def save_route_json(route_json, filename):
    """保存路线 JSON，并拒绝 NaN / Infinity。"""

    filename = Path(filename)

    filename.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with open(
        filename,
        "w",
        encoding="utf-8",
    ) as f:

        json.dump(
            route_json,
            f,
            ensure_ascii=False,
            indent=2,
            allow_nan=False,
        )


# =========================================================
# 6. 单个场景执行
# =========================================================

def run_one_scenario(
    scenario_id,
    title,
    graph,
    params,
    elevation,
    start_idx,
    wp_dict,
    target_ids,
    hab_idx,
    elapsed_min,
    event,
    output_dir,
):
    """
    执行单个场景：

    1. 计算 Return Field
    2. 执行 TSP 目标点规划
    3. 构建路线 JSON
    4. 生成安全范围 PNG
    5. 保存 JSON
    """

    width = int(params["width"])
    height = int(params["height"])

    print(f"\nPlanning scenario: {scenario_id}")

    print("Calculating Return Field...")

    return_field = get_return_field(
        graph,
        hab_idx,
    )

    print("Running TSP planner...")

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

    print("Building route JSON...")

    route_json = build_route_json(
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

    route_json["event"] = event

    # -------------------------
    # 安全范围 PNG
    # -------------------------

    png_filename = (
        f"{scenario_id}_env_{int(round(elapsed_min)):03d}.png"
    )

    png_path = Path(output_dir) / png_filename

    time_limit_min = (
        float(params["eva_budget_min"])
        - float(params["reserve_min"])
    )

    save_png_frame(
        return_field_sec=return_field,
        width=width,
        height=height,
        time_limit_min=time_limit_min,
        current_min=elapsed_min,
        filename=png_path,
    )

    # 保留原项目的 C 端帧结构。
    # TODO[C]：确认 C 端是否要求此字段结构。
    route_json["envelope_frames"] = [
        {
            "t_min": float(elapsed_min),
            "png": png_filename,
        }
    ]

    # -------------------------
    # JSON
    # -------------------------

    json_path = (
        Path(output_dir)
        / f"{scenario_id}.json"
    )

    save_route_json(
        route_json,
        json_path,
    )

    if route_json.get("error"):
        print(
            f"[WARNING] {scenario_id} planning failed: "
            f"{route_json['error']}"
        )

    else:
        print(
            f"[SUCCESS] {scenario_id}: "
            f"distance={route_json.get('total_distance_m', 0):.2f} m, "
            f"time={route_json.get('total_time_min', 0):.2f} min"
        )

    print(f"JSON: {json_path}")
    print(f"PNG:  {png_path}")

    return route_json


# =========================================================
# 7. 主场景流程
# =========================================================

def run_scenarios(
    data_dir,
    waypoint_path,
    env_path,
    output_dir,
    event_time_min,
):
    """
    运行三个场景：

        1. Nominal
        2. Slow20
        3. Dust

    Slow20 / Dust 均从 Nominal 路线上的真实事件位置开始重规划。
    """

    data_dir = Path(data_dir)
    output_dir = Path(output_dir)

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    # -----------------------------------------------------
    # Step 1. 读取 A 模块真实数据
    # -----------------------------------------------------

    print("\n========== Loading Input Data ==========")

    (
        grid_meta,
        elevation,
        rough,
        hazard,
    ) = load_grid_data(data_dir)

    width = int(grid_meta["width"])
    height = int(grid_meta["height"])

    # -----------------------------------------------------
    # Step 2. 读取任务点和参数
    # -----------------------------------------------------

    habitat, wp_dict, target_ids = load_waypoints(
        waypoint_path
    )

    base_params = load_env(
        env_path,
        grid_meta,
    )

    validate_locations(
        habitat,
        wp_dict,
        elevation,
        rough,
        hazard,
    )

    hab_idx = xy_to_idx(
        habitat["x"],
        habitat["y"],
        width,
        height,
    )

    # 当前项目默认从 Habitat 出发。
    # TODO[D]：如果未来支持非 Habitat 起点，
    # 应从任务配置中读取 start 坐标。
    start_idx = hab_idx

    print(f"Habitat: ({habitat['x']}, {habitat['y']})")
    print(f"Targets: {target_ids}")
    print(f"Event time: {event_time_min} min")

    # -----------------------------------------------------
    # Step 3. 构建 Nominal Graph
    # -----------------------------------------------------

    print("\n========== Building Base Graph ==========")

    base_graph = build_graph(
        grid_meta=grid_meta,
        elevation=elevation,
        rough=rough,
        hazard=hazard,
        params=base_params,
    )

    print(
        f"Base graph: {base_graph.shape}, "
        f"edges={base_graph.nnz}"
    )

    if base_graph.nnz == 0:
        raise RuntimeError(
            "Base graph 没有任何可通行边。"
            "请检查 hazard、NoData、坡度阈值和 BIN 数据。"
        )

    # -----------------------------------------------------
    # Step 4. Nominal
    # -----------------------------------------------------

    route_nominal = run_one_scenario(
        scenario_id="nominal",
        title="按计划执行",
        graph=base_graph,
        params=base_params,
        elevation=elevation,
        start_idx=start_idx,
        wp_dict=wp_dict,
        target_ids=target_ids,
        hab_idx=hab_idx,
        elapsed_min=0.0,
        event=None,
        output_dir=output_dir,
    )

    if route_nominal.get("error"):
        raise RuntimeError(
            "Nominal 规划失败，无法继续生成事件场景："
            f"{route_nominal['error']}"
        )

    # -----------------------------------------------------
    # Step 5. 确定事件发生位置
    # -----------------------------------------------------

    print("\n========== Determining Event Position ==========")

    event_time_min = float(event_time_min)

    if event_time_min < 0:
        raise ValueError(
            "event_time_min 不能小于 0"
        )

    event_x, event_y = get_position_at_time(
        route_json=route_nominal,
        target_time_min=event_time_min,
    )

    event_pos_idx = xy_to_idx(
        event_x,
        event_y,
        width,
        height,
    )

    print(
        f"Event triggered at "
        f"t={event_time_min:.2f} min, "
        f"position=({event_x}, {event_y})"
    )

    # -----------------------------------------------------
    # Step 6. 确定尚未完成的目标点
    # -----------------------------------------------------

    (
        remaining_target_ids,
        replanning_wp_dict,
    ) = get_remaining_targets(
        nominal_route=route_nominal,
        target_ids=target_ids,
        wp_dict=wp_dict,
        event_time_min=event_time_min,
    )

    print(
        "Remaining targets after event:",
        remaining_target_ids,
    )

    # 统一事件描述。
    # TODO[C]：确认前端需要的 event 字段。
    slow_event = {
        "type": "slow20",
        "t_min": event_time_min,
        "pos": [event_x, event_y],
        "description": "Movement speed reduced by 20%",
    }

    dust_event = {
        "type": "dust",
        "t_min": event_time_min,
        "pos": [event_x, event_y],
        "description": "Dust event reduces available EVA time",
    }

    # -----------------------------------------------------
    # Step 7. Slow20
    # -----------------------------------------------------

    print("\n========== Planning Slow20 ==========")

    slow_params = dict(base_params)

    slow_params["k"] = (
        base_params["k"]
        * base_params["slow_k_factor"]
    )

    print(
        f"Slow20 k: {base_params['k']} "
        f"-> {slow_params['k']}"
    )

    slow_graph = build_graph(
        grid_meta=grid_meta,
        elevation=elevation,
        rough=rough,
        hazard=hazard,
        params=slow_params,
    )

    route_slow = run_one_scenario(
        scenario_id="slow20",
        title="移动速度降低20%",
        graph=slow_graph,
        params=slow_params,
        elevation=elevation,
        start_idx=event_pos_idx,
        wp_dict=replanning_wp_dict,
        target_ids=remaining_target_ids,
        hab_idx=hab_idx,
        elapsed_min=event_time_min,
        event=slow_event,
        output_dir=output_dir,
    )

    # -----------------------------------------------------
    # Step 8. Dust
    # -----------------------------------------------------

    print("\n========== Planning Dust ==========")

    dust_params = dict(base_params)

    dust_params["eva_budget_min"] = (
        base_params["dust_budget_min"]
    )

    print(
        f"Dust EVA budget: "
        f"{dust_params['eva_budget_min']} min"
    )

    # Dust 当前只改变 EVA 预算，不改变地形通行时间。
    # 因此可以继续使用 Base Graph。
    route_dust = run_one_scenario(
        scenario_id="dust",
        title="尘暴缩短EVA预算",
        graph=base_graph,
        params=dust_params,
        elevation=elevation,
        start_idx=event_pos_idx,
        wp_dict=replanning_wp_dict,
        target_ids=remaining_target_ids,
        hab_idx=hab_idx,
        elapsed_min=event_time_min,
        event=dust_event,
        output_dir=output_dir,
    )

    # -----------------------------------------------------
    # Step 9. 输出场景索引
    # -----------------------------------------------------

    # TODO[C]：如果 C 端需要统一加载场景列表，
    # 可以直接读取此文件；否则可忽略。
    scenario_index = {
        "scenarios": [
            {
                "id": "nominal",
                "title": "按计划执行",
                "json": "nominal.json",
            },
            {
                "id": "slow20",
                "title": "移动速度降低20%",
                "json": "slow20.json",
            },
            {
                "id": "dust",
                "title": "尘暴缩短EVA预算",
                "json": "dust.json",
            },
        ]
    }

    index_path = output_dir / "scenarios.json"

    with open(
        index_path,
        "w",
        encoding="utf-8",
    ) as f:

        json.dump(
            scenario_index,
            f,
            ensure_ascii=False,
            indent=2,
        )

    print("\n========== All Scenarios Completed ==========")

    print(f"Output directory: {output_dir}")

    print("Generated files:")

    for filename in [
        "nominal.json",
        "nominal_env_000.png",
        f"slow20_env_{int(round(event_time_min)):03d}.png",
        "slow20.json",
        f"dust_env_{int(round(event_time_min)):03d}.png",
        "dust.json",
        "scenarios.json",
    ]:
        print(f"  - {filename}")

    return (
        route_nominal,
        route_slow,
        route_dust,
    )


# =========================================================
# 8. 命令行入口
# =========================================================

def main():

    parser = argparse.ArgumentParser(
        description="Martian Map - B Module Scenario Planner"
    )

    parser.add_argument(
        "--data",
        default="public/data",
        help="A 模块 BIN 和 grid.json 所在目录",
    )

    parser.add_argument(
        "--waypoints",
        default="public/data/waypoints.json",
        help="Habitat 和目标点配置文件",
    )

    parser.add_argument(
        "--env",
        default="public/data/env.json",
        help="规划参数配置文件",
    )

    parser.add_argument(
        "--output",
        default="public/data/scenarios",
        help="C 模块读取的场景输出目录",
    )

    parser.add_argument(
        "--event-time",
        type=float,
        default=95.0,
        help="事件发生时间，单位分钟",
    )

    args = parser.parse_args()

    run_scenarios(
        data_dir=args.data,
        waypoint_path=args.waypoints,
        env_path=args.env,
        output_dir=args.output,
        event_time_min=args.event_time,
    )


if __name__ == "__main__":
    main()
