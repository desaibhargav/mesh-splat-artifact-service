"""Offline nearest-centre correspondence; decoding stays in the native asset libraries.

SciPy cKDTree supplies the search, including degenerate/coincident coordinates.
These mappings approximate appearance across different topology, not exact surface
correspondence. No searches run in the browser. All inputs are public derivatives.
"""
import gzip
import json
from pathlib import Path
import sys

import numpy as np
from scipy.spatial import cKDTree


def positions(path):
    values = np.fromfile(path, dtype="<f4")
    if values.size == 0 or values.size % 3 or not np.isfinite(values).all():
        raise ValueError("Expected nonempty finite xyz coordinates")
    return values.reshape(-1, 3)


def write_array(path, values):
    with gzip.open(path, "wb", compresslevel=6) as stream:
        stream.write(memoryview(values).cast("B"))


def generate(config):
    canonical = positions(config["inputs"][0])
    if len(canonical) >= 2**32:
        raise ValueError("Correspondence IDs require fewer than 2^32 primitives")
    tree = cKDTree(canonical)
    output = Path(config["output"])
    output.mkdir(parents=True, exist_ok=True)
    write_array(output / "centers.bin.gz", canonical.astype("<f4"))
    for level, path in enumerate(config["inputs"]):
        current = positions(path)
        if level == 0:
            continue  # Identity is derived by the client; do not transfer it.
        _, forward = cKDTree(current).query(canonical, k=1)
        _, backward = tree.query(current, k=1)
        write_array(output / f"to-{level}.bin.gz", np.asarray(forward, dtype="<u4"))
        write_array(output / f"from-{level}.bin.gz", np.asarray(backward, dtype="<u4"))


if __name__ == "__main__":
    generate(json.loads(Path(sys.argv[1]).read_text()))
