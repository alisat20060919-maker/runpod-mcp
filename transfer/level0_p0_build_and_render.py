import bpy
import math
import json
import os
from mathutils import Vector, Matrix

ROOT = "/workspace/backrooms_world/level0_p0"
RGB_DIR = os.path.join(ROOT, "rgb")
DEPTH_DIR = os.path.join(ROOT, "depth")
NORMAL_DIR = os.path.join(ROOT, "normal")
os.makedirs(RGB_DIR, exist_ok=True)
os.makedirs(DEPTH_DIR, exist_ok=True)
os.makedirs(NORMAL_DIR, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.render.resolution_x = 518
scene.render.resolution_y = 518
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
scene.render.film_transparent = False
scene.world.color = (0.035, 0.035, 0.03)

def mat(name, rgba, roughness=0.75):
    m = bpy.data.materials.new(name)
    m.diffuse_color = rgba
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = roughness
    return m

MAT_WALL = mat("Wall_Yellow", (0.48, 0.43, 0.19, 1.0), 0.95)
MAT_FLOOR = mat("Floor_Beige", (0.24, 0.20, 0.13, 1.0), 0.98)
MAT_CEIL = mat("Ceiling_OffWhite", (0.70, 0.68, 0.52, 1.0), 0.9)
MAT_COLUMN = mat("Column_Darker", (0.36, 0.31, 0.13, 1.0), 0.95)
MAT_TRIM = mat("Door_Trim", (0.19, 0.16, 0.08, 1.0), 0.9)

def cube(name, loc, scale, material):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = (scale[0] / 2, scale[1] / 2, scale[2] / 2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(material)
    return o

def add_area_light(name, loc, energy=300, size=1.25):
    bpy.ops.object.light_add(type="AREA", location=loc)
    l = bpy.context.object
    l.name = name
    l.data.energy = energy
    l.data.shape = "RECTANGLE"
    l.data.size = size
    l.data.size_y = 0.35
    return l

def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

H = 2.8
T = 0.16
cube("Floor", (0, 0, -0.05), (10.0, 10.0, 0.10), MAT_FLOOR)
cube("Ceiling", (0, 0, H + 0.05), (10.0, 10.0, 0.10), MAT_CEIL)
cube("Wall_W", (-5, 0, H/2), (T, 10, H), MAT_WALL)
cube("Wall_E", ( 5, 0, H/2), (T, 10, H), MAT_WALL)
cube("Wall_S", (0, -5, H/2), (10, T, H), MAT_WALL)
cube("Wall_N", (0,  5, H/2), (10, T, H), MAT_WALL)

cube("Inner_H", (-1.65, 0.65, H/2), (6.7, T, H), MAT_WALL)
XW = 1.70
DOOR_Y = 2.45
DOOR_W = 1.25
DOOR_H = 2.15
seg1_len = (DOOR_Y - DOOR_W/2) - 0.65
seg2_len = 5.0 - (DOOR_Y + DOOR_W/2)
cube("Inner_V_Bottom", (XW, 0.65 + seg1_len/2, H/2), (T, seg1_len, H), MAT_WALL)
cube("Inner_V_Top", (XW, DOOR_Y + DOOR_W/2 + seg2_len/2, H/2), (T, seg2_len, H), MAT_WALL)
cube("Door_Header", (XW, DOOR_Y, DOOR_H + (H-DOOR_H)/2), (T, DOOR_W, H-DOOR_H), MAT_TRIM)

cube("Column_A", (-2.85, -1.85, 1.25), (0.48, 0.48, 2.50), MAT_COLUMN)
cube("Column_B", ( 3.15,  1.05, 1.25), (0.62, 0.62, 2.50), MAT_COLUMN)
cube("Alcove_Block", (-4.25, 2.65, 1.10), (1.35, 1.25, 2.20), MAT_WALL)

for i, (x, y) in enumerate([
    (-3.2,-3.0), (-0.8,-3.0), (1.8,-3.0), (3.6,-1.2),
    (3.5, 1.3), (2.7, 3.5), (0.0, 3.6), (-2.8, 3.4),
    (-3.6, 0.5), (-1.2,-0.2)
]):
    add_area_light(f"Light_{i:02d}", (x, y, 2.68))

camera_specs = [
    ((-3.70,-3.65,1.60), (-1.70,-2.45,1.45)),
    ((-2.35,-3.80,1.60), ( 0.10,-3.00,1.45)),
    ((-0.85,-3.80,1.60), ( 1.75,-2.65,1.45)),
    (( 0.80,-3.65,1.60), ( 3.25,-2.20,1.45)),
    (( 2.55,-3.20,1.60), ( 3.75,-0.50,1.45)),
    (( 3.75,-2.00,1.60), ( 3.15, 0.95,1.45)),
    (( 3.85,-0.25,1.60), ( 2.95, 2.35,1.45)),
    (( 3.55, 1.55,1.60), ( 1.70, 2.45,1.45)),
    (( 3.10, 3.45,1.60), ( 0.90, 3.65,1.45)),
    (( 1.10, 3.70,1.60), (-1.30, 3.45,1.45)),
    ((-1.05, 3.70,1.60), (-3.55, 2.85,1.45)),
    ((-3.10, 3.20,1.60), (-4.05, 1.10,1.45)),
    ((-3.75, 1.30,1.60), (-3.00,-0.65,1.45)),
    ((-3.75,-0.65,1.60), (-2.30,-2.55,1.45)),
    ((-1.15,-1.10,1.60), ( 1.55, 0.35,1.45)),
    (( 2.30, 0.05,1.60), ( 0.00, 1.65,1.45)),
]

cams = []
for i, (loc, tgt) in enumerate(camera_specs):
    bpy.ops.object.camera_add(location=loc)
    cam = bpy.context.object
    cam.name = f"CAM_{i:02d}"
    cam.data.lens = 35.0
    cam.data.sensor_width = 36.0
    cam.data.sensor_fit = "HORIZONTAL"
    look_at(cam, tgt)
    cams.append(cam)

view_layer = scene.view_layers["ViewLayer"]
view_layer.use_pass_z = True
view_layer.use_pass_normal = True
scene.use_nodes = True
tree = scene.node_tree
tree.nodes.clear()
rl = tree.nodes.new("CompositorNodeRLayers")

depth_out = tree.nodes.new("CompositorNodeOutputFile")
depth_out.base_path = DEPTH_DIR
depth_out.format.file_format = "OPEN_EXR"
depth_out.format.color_mode = "BW"
depth_out.format.color_depth = "32"
tree.links.new(rl.outputs["Depth"], depth_out.inputs[0])

normal_out = tree.nodes.new("CompositorNodeOutputFile")
normal_out.base_path = NORMAL_DIR
normal_out.format.file_format = "OPEN_EXR"
normal_out.format.color_mode = "RGB"
normal_out.format.color_depth = "32"
tree.links.new(rl.outputs["Normal"], normal_out.inputs[0])

W = scene.render.resolution_x
HPIX = scene.render.resolution_y
poses = {
    "scene": "Level0_P0_10m",
    "resolution": [W, HPIX],
    "camera_model": "Blender perspective; local forward=-Z, local up=+Y",
    "cameras": []
}
axis_fix = Matrix(((1,0,0,0),(0,-1,0,0),(0,0,-1,0),(0,0,0,1)))

for i, cam in enumerate(cams):
    scene.camera = cam
    scene.frame_set(i + 1)
    scene.render.filepath = os.path.join(RGB_DIR, f"cam_{i:02d}.png")
    depth_out.file_slots[0].path = f"cam_{i:02d}_"
    normal_out.file_slots[0].path = f"cam_{i:02d}_"
    bpy.ops.render.render(write_still=True)

    frame_suffix = f"{i+1:04d}"
    for folder in (DEPTH_DIR, NORMAL_DIR):
        src = os.path.join(folder, f"cam_{i:02d}_{frame_suffix}.exr")
        dst = os.path.join(folder, f"cam_{i:02d}.exr")
        if os.path.exists(src):
            if os.path.exists(dst): os.remove(dst)
            os.rename(src, dst)

    fx = 0.5 * W / math.tan(cam.data.angle_x / 2.0)
    fy = 0.5 * HPIX / math.tan(cam.data.angle_y / 2.0)
    K = [[fx, 0.0, W/2.0], [0.0, fy, HPIX/2.0], [0.0, 0.0, 1.0]]
    c2w_blender = cam.matrix_world.copy()
    w2c_blender = c2w_blender.inverted()
    c2w_opencv = c2w_blender @ axis_fix
    poses["cameras"].append({
        "id": i,
        "name": cam.name,
        "rgb": f"rgb/cam_{i:02d}.png",
        "depth": f"depth/cam_{i:02d}.exr",
        "normal": f"normal/cam_{i:02d}.exr",
        "K": K,
        "c2w_blender": [list(row) for row in c2w_blender],
        "w2c_blender": [list(row) for row in w2c_blender],
        "c2w_opencv": [list(row) for row in c2w_opencv],
        "location": list(cam.location),
        "lens_mm": cam.data.lens,
        "sensor_width_mm": cam.data.sensor_width,
    })

with open(os.path.join(ROOT, "camera_poses.json"), "w", encoding="utf-8") as f:
    json.dump(poses, f, ensure_ascii=False, indent=2)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, "level0_p0_canonical.blend"))

print("LEVEL0_P0_DONE")
print(ROOT)
print("RGB:", len(os.listdir(RGB_DIR)))
print("DEPTH:", len(os.listdir(DEPTH_DIR)))
print("NORMAL:", len(os.listdir(NORMAL_DIR)))
