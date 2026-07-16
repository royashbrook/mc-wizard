#!/usr/bin/env python3
"""Enable Bedrock's Beta APIs experiment in a stopped world's level.dat."""

import json
import os
import shutil
import struct
import sys
from pathlib import Path

FLAGS = ("gametest", "experiments_ever_used", "saved_with_toggled_experiments")


class Parser:
    def __init__(self, data):
        self.data = data
        self.pos = 8
        self.compounds = {}

    def take(self, fmt):
        size = struct.calcsize("<" + fmt)
        if self.pos + size > len(self.data):
            raise ValueError("truncated level.dat")
        result = struct.unpack_from("<" + fmt, self.data, self.pos)
        self.pos += size
        return result[0] if len(result) == 1 else result

    def string(self):
        length = self.take("H")
        end = self.pos + length
        if end > len(self.data):
            raise ValueError("truncated NBT string")
        result = bytes(self.data[self.pos:end]).decode("utf-8")
        self.pos = end
        return result

    def count(self, width):
        count = self.take("i")
        if count < 0:
            raise ValueError("negative NBT collection count")
        self.pos += width * count

    def skip(self, tag_type, path):
        if tag_type == 1:
            self.take("b")
        elif tag_type == 2:
            self.take("h")
        elif tag_type == 3:
            self.take("i")
        elif tag_type == 4:
            self.take("q")
        elif tag_type == 5:
            self.take("f")
        elif tag_type == 6:
            self.take("d")
        elif tag_type == 7:
            self.count(1)
        elif tag_type == 8:
            self.string()
        elif tag_type == 9:
            child_type = self.take("B")
            count = self.take("i")
            if count < 0 or (child_type == 0 and count):
                raise ValueError("invalid NBT list")
            for index in range(count):
                self.skip(child_type, path + (f"[{index}]",))
        elif tag_type == 10:
            children = {}
            while True:
                entry_start = self.pos
                child_type = self.take("B")
                if child_type == 0:
                    self.compounds[path] = {"children": children, "end": entry_start}
                    break
                name = self.string()
                value_start = self.pos
                self.skip(child_type, path + (name,))
                children[name] = {"type": child_type, "value": value_start}
        elif tag_type == 11:
            self.count(4)
        elif tag_type == 12:
            self.count(8)
        else:
            raise ValueError(f"unknown NBT tag type {tag_type} at {path}")
        if self.pos > len(self.data):
            raise ValueError("NBT value extends past EOF")

    def parse(self):
        tag_type = self.take("B")
        if tag_type != 10:
            raise ValueError(f"expected root compound, got tag {tag_type}")
        self.string()
        self.skip(tag_type, ())
        if self.pos != len(self.data):
            raise ValueError(f"NBT ended at {self.pos}, file ends at {len(self.data)}")
        return self.compounds


def inspect(data):
    if len(data) < 9:
        raise ValueError("not a Bedrock level.dat")
    version, declared = struct.unpack_from("<II", data, 0)
    if version < 4 or version > 10:
        raise ValueError(f"unexpected Bedrock level.dat version {version}")
    if declared != len(data) - 8:
        raise ValueError(f"header says {declared} NBT bytes; found {len(data) - 8}")
    return Parser(data).parse()


def named_header(tag_type, name):
    encoded = name.encode("utf-8")
    return bytes((tag_type,)) + struct.pack("<H", len(encoded)) + encoded


def byte_entry(name, value=1):
    return named_header(1, name) + bytes((value,))


def patch_bytes(source, experiment_values=None, world_options=None):
    experiment_values = dict(experiment_values or {name: True for name in FLAGS})
    world_options = dict(world_options or {})
    data = bytearray(source)
    compounds = inspect(data)
    root = compounds[()]
    root_additions = bytearray()
    for name, value in world_options.items():
        if not name or not name.replace("_", "").isalnum() or not name[0].isalpha():
            raise ValueError(f"invalid world option {name!r}")
        child = root["children"].get(name)
        if child is None:
            if isinstance(value, bool):
                root_additions += byte_entry(name, int(value))
            elif isinstance(value, int) and -(2**31) <= value < 2**31:
                root_additions += named_header(3, name) + struct.pack("<i", value)
            else:
                raise ValueError(f"world option {name} must be a byte or 32-bit integer")
        elif child["type"] == 1 and isinstance(value, (bool, int)):
            data[child["value"]] = int(value) & 0xFF
        elif child["type"] == 3 and isinstance(value, (bool, int)):
            struct.pack_into("<i", data, child["value"], int(value))
        else:
            raise ValueError(f"world option {name} has unsupported NBT type {child['type']}")
    if root_additions:
        data[root["end"]:root["end"]] = root_additions
        struct.pack_into("<I", data, 4, len(data) - 8)

    compounds = inspect(data)
    root = compounds[()]
    root_experiments = root["children"].get("experiments")
    if root_experiments and root_experiments["type"] != 10:
        raise ValueError("root experiments entry is not a compound")
    experiments = compounds.get(("experiments",))
    if experiments is None:
        body = b"".join(byte_entry(name, int(value)) for name, value in experiment_values.items()) + b"\x00"
        data[root["end"]:root["end"]] = named_header(10, "experiments") + body
    else:
        additions = bytearray()
        for name, value in experiment_values.items():
            if not name or not name.replace("_", "").isalnum() or not name[0].isalpha():
                raise ValueError(f"invalid experiment {name!r}")
            child = experiments["children"].get(name)
            if child is None:
                additions += byte_entry(name, int(value))
            elif child["type"] != 1:
                raise ValueError(f"experiments.{name} is not TAG_Byte")
            else:
                data[child["value"]] = int(value)
        data[experiments["end"]:experiments["end"]] = additions
    struct.pack_into("<I", data, 4, len(data) - 8)

    patched = inspect(data)[("experiments",)]
    for name, value in experiment_values.items():
        child = patched["children"].get(name)
        if child is None or child["type"] != 1 or data[child["value"]] != int(value):
            raise ValueError(f"post-write validation failed for experiments.{name}")
    return data


def self_test():
    experiments = named_header(10, "experiments") + byte_entry("experiments_ever_used", 0) + b"\x00"
    payload = named_header(10, "") + byte_entry("educationFeaturesEnabled", 0) \
        + named_header(3, "eduOffer") + struct.pack("<i", 0) + experiments + b"\x00"
    source = struct.pack("<II", 10, len(payload)) + payload
    patched = patch_bytes(source)
    assert len(patched) > len(source)
    assert patch_bytes(patched) == patched
    configured = patch_bytes(source, {"gametest": True, "holiday_creator_features": False}, {
        "educationFeaturesEnabled": True, "eduOffer": 1, "immutableWorld": False,
    })
    compounds = inspect(configured)
    root = compounds[()]["children"]
    assert configured[root["educationFeaturesEnabled"]["value"]] == 1
    assert struct.unpack_from("<i", configured, root["eduOffer"]["value"])[0] == 1
    assert configured[root["immutableWorld"]["value"]] == 0
    print("enable-beta-apis self-test passed")


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return
    control = None
    if len(sys.argv) == 4 and sys.argv[1] == "--control-json":
        path = Path(sys.argv[2]).resolve()
        control = json.loads(sys.argv[3])
    elif len(sys.argv) == 2:
        path = Path(sys.argv[1]).resolve()
    else:
        raise SystemExit("usage: enable-beta-apis.py [--control-json] /path/to/world/level.dat [json]")
    original = path.read_bytes()
    patched = patch_bytes(
        original,
        control.get("experiments", {}) if control else None,
        control.get("worldOptions", {}) if control else None,
    )
    backup_suffix = f".pre-control.{os.getpid()}.bak" if control else ".pre-beta.bak"
    backup = path.with_suffix(path.suffix + backup_suffix)
    if backup.exists():
        raise FileExistsError(f"refusing to replace existing backup: {backup}")
    shutil.copy2(path, backup)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_bytes(patched)
    os.replace(temp, path)
    print(f"updated Bedrock world settings in {path}" if control else f"enabled Beta APIs in {path}")
    print(f"backup: {backup}")
    if control:
        print(f"validated {len(control.get('experiments', {}))} experiments and {len(control.get('worldOptions', {}))} world options")
    else:
        print("validated experiments.gametest, experiments_ever_used, saved_with_toggled_experiments = 1")


if __name__ == "__main__":
    main()
