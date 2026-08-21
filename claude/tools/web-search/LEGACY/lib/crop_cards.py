#!/usr/bin/env python3
"""목록 캡처 한 장에서 카드 자리들을 잘라 낸다.

[원칙] 요소를 다시 찍지 않는다. 판정에 쓴 그 캡처에서 잘라야 "그 화면의 그 카드"다.
[원칙] 배율은 짐작하지 않는다. 실제 캡처 픽셀 크기와 페이지 CSS 크기의 비로 잰다.
[원칙] 캡처 밖은 잘라 낸 척하지 않는다. 잘림 구역 밖이면 실패 사유를 남긴다.

입력(표준입력, JSON):
  { "shot": "...jpg", "out_dir": "...", "css_width": 1280, "css_height": 4200,
    "boxes": [ { "name": "000", "x": 0, "y": 0, "w": 240, "h": 320 } ] }
출력(표준출력, JSON):
  { "ok": true, "shot_px": [w,h], "scale": [sx,sy],
    "results": [ { "name","ok","path","w","h","bytes","why" } ] }
"""
import json
import os
import sys

try:
    from PIL import Image
except Exception as e:  # noqa: BLE001
    print(json.dumps({"ok": False, "why": f"pillow_missing: {e}"}))
    sys.exit(0)


def main() -> None:
    req = json.loads(sys.stdin.read())
    shot = req["shot"]
    out_dir = req["out_dir"]
    boxes = req.get("boxes", [])
    css_w = float(req.get("css_width") or 0)
    css_h = float(req.get("css_height") or 0)

    if not os.path.exists(shot):
        print(json.dumps({"ok": False, "why": "shot_missing"}))
        return

    im = Image.open(shot)
    px_w, px_h = im.size
    # 배율: 캡처 픽셀 / CSS 픽셀. 세로는 잘린 캡처일 수 있으므로 가로 배율을 기준으로 삼는다.
    sx = (px_w / css_w) if css_w > 0 else 1.0
    sy = sx
    os.makedirs(out_dir, exist_ok=True)

    results = []
    for b in boxes:
        name = str(b["name"])
        x0 = int(round(b["x"] * sx))
        y0 = int(round(b["y"] * sy))
        x1 = int(round((b["x"] + b["w"]) * sx))
        y1 = int(round((b["y"] + b["h"]) * sy))
        if x0 >= px_w or y0 >= px_h or x1 <= 0 or y1 <= 0:
            # 잘린 캡처의 바깥이다. 잘라 낸 척하지 않는다.
            results.append({"name": name, "ok": False, "why": "outside_shot",
                            "asked": [x0, y0, x1, y1], "shot_px": [px_w, px_h]})
            continue
        # 음수 자리를 그대로 넘기면 Pillow 가 검은 여백을 채워 준다.
        # 그 여백은 화면에 없던 픽셀이므로 캡처의 일부인 척하면 안 된다.
        cx0 = max(0, x0)
        cy0 = max(0, y0)
        cx1 = min(x1, px_w)
        cy1 = min(y1, px_h)
        clipped = (cx0 != x0) or (cy0 != y0) or (cx1 != x1) or (cy1 != y1)
        x0, y0 = cx0, cy0
        if cx1 - x0 < 2 or cy1 - y0 < 2:
            results.append({"name": name, "ok": False, "why": "empty_after_clip",
                            "asked": [x0, y0, x1, y1], "shot_px": [px_w, px_h]})
            continue
        out = os.path.join(out_dir, f"{name}.jpg")
        im.crop((x0, y0, cx1, cy1)).convert("RGB").save(out, "JPEG", quality=82)
        st = os.stat(out)
        with Image.open(out) as chk:
            cw, ch = chk.size
        results.append({"name": name, "ok": cw > 0 and ch > 0 and st.st_size > 0,
                        "path": out, "w": cw, "h": ch, "bytes": st.st_size,
                        "why": "clipped_to_shot" if clipped else None,
                        "pixel_box": [x0, y0, cx1, cy1]})

    print(json.dumps({"ok": True, "shot_px": [px_w, px_h], "scale": [sx, sy], "results": results}))


if __name__ == "__main__":
    main()
