# -*- coding: utf-8 -*-
"""リッチメニュー画像を生成する。既存 icons/ の配色（緑=在庫 / 紺=買い物リスト）に合わせる。"""
import math

from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 1686
COLS = [(0, 625), (625, 625), (1250, 625), (1875, 625)]   # (x, width) 合計 2500
ROWS = [(0, 843), (843, 843)]

GREEN      = (47, 125, 92)     # #2F7D5C 在庫
GREEN_DARK = (30, 91, 65)      # #1E5B41
BLUE       = (44, 76, 124)     # #2C4C7C 買い物リスト
BLUE_DARK  = (32, 56, 92)
ORANGE     = (224, 122, 62)    # #E07A3E アクセント
GRAY       = (92, 99, 105)     # 取消。在庫にも買い物リストにも属さないので中間色
GRAY_DARK  = (66, 72, 77)
RED        = (166, 62, 56)     # 全削除。戻せるが影響が大きいので警告色
WHITE      = (255, 255, 255)
LINE       = (255, 255, 255)

FONT = "C:/Windows/Fonts/YuGothB.ttc"
label_font = ImageFont.truetype(FONT, 86, index=0)
sub_font   = ImageFont.truetype(FONT, 52, index=0)

img = Image.new("RGB", (W, H), WHITE)
d = ImageDraw.Draw(img)


def center(cx, cy, text, font, fill):
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    d.text((cx - (r - l) / 2 - l, cy - (b - t) / 2 - t), text, font=font, fill=fill)


# ---------------------------------------------------------------- アイコン

def icon_calendar(cx, cy, s, fg, bg):
    """カレンダー。既存 a-calendar.png と同じ形"""
    w, h = s * 1.08, s
    x0, y0 = cx - w / 2, cy - h / 2
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=s * 0.11, fill=fg)
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h * 0.27], radius=s * 0.11, fill=bg)
    d.rectangle([x0, y0 + h * 0.16, x0 + w, y0 + h * 0.27], fill=bg)
    for fx in (0.26, 0.74):
        rw = s * 0.085
        d.rounded_rectangle([x0 + w * fx - rw / 2, y0 - s * 0.14,
                             x0 + w * fx + rw / 2, y0 + s * 0.13],
                            radius=rw / 2, fill=(220, 233, 225))
    # 中央のドット（日付）
    for r in range(2):
        for c in range(3):
            dx = x0 + w * (0.28 + c * 0.22)
            dy = y0 + h * (0.48 + r * 0.24)
            d.ellipse([dx - s * 0.05, dy - s * 0.05, dx + s * 0.05, dy + s * 0.05], fill=bg)


def icon_check(cx, cy, s, fg, bg):
    """丸にチェック＝使用済"""
    d.ellipse([cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2], fill=fg)
    d.line([(cx - s * 0.22, cy + s * 0.02), (cx - s * 0.05, cy + s * 0.19),
            (cx + s * 0.24, cy - s * 0.19)], fill=bg, width=int(s * 0.11),
           joint="curve")


def icon_trash(cx, cy, s, fg, bg):
    """ゴミ箱＝破棄済"""
    w, h = s * 0.82, s * 0.9
    x0, y0 = cx - w / 2, cy - h / 2 + s * 0.1
    d.rounded_rectangle([x0 - s * 0.12, y0 - s * 0.16, x0 + w + s * 0.12, y0 - s * 0.04],
                        radius=s * 0.06, fill=fg)
    d.rounded_rectangle([cx - s * 0.16, y0 - s * 0.28, cx + s * 0.16, y0 - s * 0.14],
                        radius=s * 0.05, fill=fg)
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=s * 0.09, fill=fg)
    for fx in (0.3, 0.5, 0.7):
        d.rounded_rectangle([x0 + w * fx - s * 0.035, y0 + h * 0.18,
                             x0 + w * fx + s * 0.035, y0 + h * 0.82],
                            radius=s * 0.035, fill=bg)


def icon_list(cx, cy, s, fg, bg, mark=None):
    """リスト。mark で + / - / なし"""
    w, h = s * 0.88, s
    x0, y0 = cx - w / 2, cy - h / 2
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=s * 0.1, fill=fg)
    for i in range(3):
        ly = y0 + h * (0.28 + i * 0.22)
        d.ellipse([x0 + w * 0.16 - s * 0.05, ly - s * 0.05,
                   x0 + w * 0.16 + s * 0.05, ly + s * 0.05], fill=bg)
        d.rounded_rectangle([x0 + w * 0.34, ly - s * 0.035, x0 + w * 0.84, ly + s * 0.035],
                            radius=s * 0.035, fill=bg)
    if mark:
        bx, by, br = cx + w * 0.46, cy + h * 0.42, s * 0.23
        d.ellipse([bx - br, by - br, bx + br, by + br], fill=ORANGE)
        d.ellipse([bx - br * 0.82, by - br * 0.82, bx + br * 0.82, by + br * 0.82], fill=WHITE)
        t = br * 0.16
        d.rounded_rectangle([bx - br * 0.46, by - t, bx + br * 0.46, by + t],
                            radius=t, fill=ORANGE)
        if mark == "+":
            d.rounded_rectangle([bx - t, by - br * 0.46, bx + t, by + br * 0.46],
                                radius=t, fill=ORANGE)


def icon_undo(cx, cy, s, fg, bg):
    """左へ戻る矢印＝取消"""
    r = s * 0.38
    lw = int(s * 0.15)
    # 上side を開けた円弧。PIL の角度は 0=右, 90=下, 270=上
    d.arc([cx - r, cy - r, cx + r, cy + r], start=300, end=600, fill=fg, width=lw)

    # 円弧の左上の端に矢じりを置く
    px = cx + r * math.cos(math.radians(240))
    py = cy + r * math.sin(math.radians(240))
    a = s * 0.21
    d.polygon([(px - a * 1.05, py - a * 0.10),
               (px + a * 0.35, py - a * 1.00),
               (px + a * 0.55, py + a * 0.70)], fill=fg)


def icon_clear(cx, cy, s, fg, bg):
    """リストに × ＝買い物リストの全削除"""
    icon_list(cx, cy, s, fg, bg)
    w, h = s * 0.88, s
    bx, by, br = cx + w * 0.46, cy + h * 0.42, s * 0.26
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=WHITE)
    d.ellipse([bx - br * 0.84, by - br * 0.84, bx + br * 0.84, by + br * 0.84], fill=bg)
    t = br * 0.15
    for a, b in (((-1, -1), (1, 1)), ((-1, 1), (1, -1))):
        d.line([(bx + a[0] * br * 0.36, by + a[1] * br * 0.36),
                (bx + b[0] * br * 0.36, by + b[1] * br * 0.36)],
               fill=WHITE, width=int(t * 2.4))


# ---------------------------------------------------------------- 配置

CELLS = [
    # (col, row, 見出し, 2行目, アイコン, 背景, 前景)
    (0, 0, "期限登録", None,       icon_calendar, GREEN, GREEN_DARK),
    (1, 0, "使用済",   None,       icon_check,    GREEN, GREEN_DARK),
    (2, 0, "破棄済",   None,       icon_trash,    GREEN, GREEN_DARK),
    # 取消は在庫にも買い物リストにも効くので、どちらの色にも寄せない
    (3, 0, "取消",     None,       icon_undo,     GRAY,  GRAY_DARK),
    (0, 1, "買い物リスト", "追加",  lambda *a: icon_list(*a, mark="+"), BLUE, BLUE_DARK),
    (1, 1, "買い物リスト", "削除",  lambda *a: icon_list(*a, mark="-"), BLUE, BLUE_DARK),
    (2, 1, "買い物リスト", "表示",  icon_list,                          BLUE, BLUE_DARK),
    # 全削除は取消で戻せるが影響が大きいので、押す前に気づけるよう色を変える
    (3, 1, "買い物リスト", "全削除", icon_clear,                        RED,  BLUE_DARK),
]

for col, row, title, sub, icon, bg, fg in CELLS:
    x, w = COLS[col]
    y, h = ROWS[row]
    d.rectangle([x, y, x + w, y + h], fill=bg)
    icon(x + w / 2, y + h * 0.36, h * 0.30, WHITE, bg)
    if sub:
        center(x + w / 2, y + h * 0.70, title, sub_font, WHITE)
        center(x + w / 2, y + h * 0.84, sub, label_font, WHITE)
    else:
        center(x + w / 2, y + h * 0.76, title, label_font, WHITE)

# 区切り線
for x, w in COLS[1:]:
    d.rectangle([x - 4, 0, x + 4, H], fill=LINE)
d.rectangle([0, ROWS[1][0] - 4, W, ROWS[1][0] + 4], fill=LINE)

# ---------------------------------------------------------------- 出力

import base64
import io
import os
import sys

out = sys.argv[1] if len(sys.argv) > 1 else "richmenu.png"

# 平坦な塗りなのでパレット化すると見た目を保ったまま半分以下になる。
# コードに base64 で埋め込むぶん、小さいほうが扱いやすい。
img.convert("P", palette=Image.ADAPTIVE, colors=64).save(
    out, "PNG", optimize=True, compress_level=9)
print("%s %dx%d %.1f KB" % (out, W, H, os.path.getsize(out) / 1024))

# GAS へ貼り付ける .gs も同時に吐く。PNG だけ更新して貼り忘れる事故を防ぐため
b64 = base64.b64encode(open(out, "rb").read()).decode()
CHUNK = 500
NL = chr(10)
gs = os.path.join(os.path.dirname(out) or ".", "RichMenuImage.gs")
with io.open(gs, "w", encoding="utf-8") as f:
    f.write(NL.join([
        u"/**",
        u" * リッチメニューの画像（%dx%d PNG）を base64 で埋め込んだもの。" % (W, H),
        u" * 手で編集しないこと。richmenu.py が richmenu.png と一緒に生成する。",
        u" *",
        u" * Drive を使わずに済ませるためにコードへ持たせている。",
        u" * setupRichMenu() から参照する。",
        u" */",
        u"var RICHMENU_IMAGE_BASE64 = [",
    ] + [u"  '" + b64[i:i + CHUNK] + u"'," for i in range(0, len(b64), CHUNK)]
      + [u"].join('');", u""]))
print("%s base64 %.1f KB" % (gs, len(b64) / 1024))
