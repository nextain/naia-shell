with open('packages/shell/src/lib/config.ts', 'r') as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    if 'export interface AppConfig {' in line:
        lines.insert(i + 1, '    installedWebApps?: string[];\n')
        break

with open('packages/shell/src/lib/config.ts', 'w') as f:
    f.writelines(lines)
