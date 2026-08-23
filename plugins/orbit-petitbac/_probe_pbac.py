# -*- coding: utf-8 -*-
from pathlib import Path

def dump(path, start, end):
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    for i in range(start, end + 1):
        line = lines[i - 1]
        safe = line.encode("ascii", "backslashreplace").decode("ascii")
        print("%d:%s" % (i, safe))

js = r"C:\Users\famil\entrenous-orbit\plugins\orbit-petitbac\orbit-petitbac.js"
py = r"C:\Users\famil\Bac\plugins\PetitBac\local\game.py"
print("=== headBadge ===")
dump(js, 5284, 5298)
print("=== mode lbl ===")
dump(js, 5353, 5362)
print("=== end sig ===")
dump(js, 4654, 4666)
print("=== panel sig ===")
dump(js, 4892, 4900)
print("=== react ===")
dump(js, 4450, 4456)
print("=== bot ===")
dump(py, 745, 756)
print("=== mode wrap html ===")
dump(js, 2608, 2616)
