#!/usr/bin/env python3
"""Install or remove this user's macOS login launch job; no system-wide changes."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--remove', action='store_true')
args = parser.parse_args()
label = 'local.deepseek-harness.safe-update'
domain = f'gui/{os.getuid()}'
plist = Path.home() / 'Library/LaunchAgents' / f'{label}.plist'
if args.remove:
    subprocess.run(['launchctl', 'bootout', f'{domain}/{label}'], check=False, capture_output=True)
    plist.unlink(missing_ok=True)
    print('Mac login startup disabled')
else:
    node = shutil.which('node')
    pnpm = shutil.which('pnpm')
    if not node or not pnpm:
        raise SystemExit('Node.js and pnpm must be available before enabling login startup')
    root = Path(os.environ.get('DSH_SAFE_UPDATE_ROOT', str(Path.home() / '.local/share/dsh-safe-release-update')))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    source = Path(os.environ.get('DSH_SOURCE', str(Path(__file__).resolve().parent.parent / 'deepseek-harness'))).resolve()
    if not (source / 'apps/cli/package.json').is_file():
        raise SystemExit('Set DSH_SOURCE to your Harness source checkout before enabling login startup')
    data = {
        'Label': label,
        'ProgramArguments': [node, str(Path(__file__).resolve().parent / 'supervisor.mjs'),
                             str(source),
                             os.environ.get('DSH_HOME', str(Path.home() / '.dsh')), str(root)],
        'RunAtLoad': True,
        'EnvironmentVariables': {'PATH': f'{Path(node).parent}:{Path(pnpm).parent}:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(Path.home())},
        'StandardOutPath': str(root / 'login-supervisor.log'),
        'StandardErrorPath': str(root / 'login-supervisor.log'),
    }
    plist.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive user-private writing avoids following an existing plist symlink.
    temporary = plist.with_suffix('.tmp')
    with temporary.open('xb') as stream:
        os.chmod(temporary, 0o600)
        plistlib.dump(data, stream)
    temporary.replace(plist)
    subprocess.run(['launchctl', 'bootout', f'{domain}/{label}'], check=False, capture_output=True)
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    print('Mac login startup enabled; Harness startup performs the official release check')
