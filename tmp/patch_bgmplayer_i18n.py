import sys
sys.stdout.reconfigure(encoding='utf-8')

path = r'D:\alpha-adk\projects\naia-os\shell\src\components\BgmPlayer.tsx'
with open(path, 'rb') as f:
    content = f.read().decode('utf-8')

# 1. Add t import
old_import = 'import { listNaiaAssets, toLocalBlobUrl } from "../lib/adk-store";'
new_import = 'import { listNaiaAssets, toLocalBlobUrl } from "../lib/adk-store";\nimport { t } from "../lib/i18n";'
content = content.replace(old_import, new_import)

replacements = [
    ('currentYt?.title ?? "YouTube BGM"', 'currentYt?.title ?? t("bgm.defaultYouTubeTrack")'),
    ('localNames[localIndex] ?? "\ub85c\ucec8 BGM"', 'localNames[localIndex] ?? t("bgm.defaultLocalTrack")'),
    ('title={\u0070\u0061\u006e\u0065\u006c\u0045\u0078\u0070\u0061\u006e\u0064\u0065\u0064 ? "\ud328\ub110 \ub2eb\uae30" : "BGM \ud328\ub110 \uc5f4\uae30"}',
     'title={panelExpanded ? t("bgm.close") : t("bgm.panelToggleTitle")}'),
    ('title="BGM \ud328\ub110 \uc5f4\uae30/\ub2eb\uae30"', 'title={t("bgm.panelToggleTitle")}'),
    ('title="\uc774\uc804"', 'title={t("bgm.prev")}'),
    ('title="\ub2e4\uc74c"', 'title={t("bgm.next")}'),
    ('title={playing ? "\uc77c\uc2dc\uc815\uc9c0" : "\uc7ac\uc0dd"}', 'title={playing ? t("bgm.pause") : t("bgm.play")}'),
    ('title="\ubcfc\ub968"', 'title={t("bgm.volume")}'),
    ('title="\ub4dc\ub798\uadf8: \ub192\uc774 \uc870\uc808 / \ud074\ub9ad: \uc5f4\uae30\u00b7\ub2eb\uae30"', 'title={t("bgm.drawerTitle")}'),
    ('title="\ub2eb\uae30"', 'title={t("bgm.close")}'),
    ('>\u266a \ub85c\ucec8<', '>{t("bgm.tabLocal")}<'),
    ('placeholder="YouTube \uac80\uc0c9\u2026"', 'placeholder={t("bgm.searchPlaceholder")}'),
    ('{searching ? "\u2026" : "\U0001f50d"}', '{searching ? "\u2026" : "\U0001f50d"}'),
    ('>\uc7a5\ub974<', '>{t("bgm.tabGenres")}<'),
    ('>\uac80\uc0c9\uacb0\uacfc<', '>{t("bgm.tabSearch")}<'),
    ('"\uc990\uaca8\ucc3e\uae30 "', 't("bgm.tabFavorites") + " "'),
    ('"\uac80\uc0c9 \uc911\u2026"', 't("bgm.searching")'),
    ('"\uacb0\uacfc \uc5c6\uc74c"', 't("bgm.noResults")'),
    ('"\uc990\uaca8\ucc3e\uae30\uac00 \ube44\uc5b4 \uc788\uc2b5\ub2c8\ub2e4"', 't("bgm.favEmpty")'),
    ('"\ud2b8\ub799 \uc5c6\uc74c (naia-settings/bgm-musics/)"', 't("bgm.noTracks")'),
    ('title={fav ? "\uc990\uaca8\ucc3e\uae30 \uc81c\uac70" : "\uc990\uaca8\ucc3e\uae30 \ucd94\uac00"}',
     'title={fav ? t("bgm.favRemove") : t("bgm.favAdd")}'),
    ('"\ub85c\ub529 \uc911\u2026"', 't("bgm.loading")'),
]

applied = []
skipped = []
for old, new in replacements:
    if old in content:
        content = content.replace(old, new)
        applied.append(old[:40])
    else:
        skipped.append(old[:40])

with open(path, 'wb') as f:
    f.write(content.encode('utf-8'))

print('Applied:', len(applied))
print('Skipped:', len(skipped))
for s in skipped:
    print('  SKIP:', s)
print('done')
