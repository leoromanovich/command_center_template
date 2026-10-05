"""Trusted file tools. Runs only inside the sandbox; requests arrive on stdin."""
import json
import os
from pathlib import Path
import sys

LIMIT = 2 * 1024 * 1024


def target(value, write=False):
    raw = Path(value)
    if '.git' in raw.parts:
        raise ValueError('Git metadata is unavailable')
    resolved = raw.resolve()
    kb_stage = os.environ.get('CC_STAGE') == 'knowledge'
    roots = [Path('/knowledge') if kb_stage else Path('/workspace')] if write else [Path('/workspace'), Path('/context'), Path('/knowledge')]
    if not any(resolved == root or root in resolved.parents for root in roots):
        raise ValueError('Path outside allowed roots')
    if any(part == '.git' or (part.startswith('.env') and part != '.env.example') for part in resolved.parts):
        raise ValueError('Metadata and environment secrets are unavailable')
    if write and kb_stage:
        allowed = json.loads(os.environ.get('CC_KNOWLEDGE_WRITES', '[]'))
        if str(resolved.relative_to('/knowledge')) not in allowed:
            raise ValueError('Knowledge path was not approved')
        if any(part.startswith('.') for part in resolved.relative_to('/knowledge').parts):
            raise ValueError('Knowledge metadata is unavailable')
    return resolved


def read(file):
    if not file.is_file() or file.stat().st_size > LIMIT:
        raise ValueError('Read a regular text file up to 2 MiB')
    value = file.read_text()
    if '\0' in value:
        raise ValueError('Binary files are unsupported by cc_read')
    return value


def main(request):
    name, args = request['tool'], request['args']
    file = target(args.get('path', '/workspace'), name in ('cc_write', 'cc_edit'))
    if name == 'cc_read':
        lines = read(file).splitlines(keepends=True)
        start = max(0, args.get('offset', 1) - 1)
        return ''.join(lines[start:start + args.get('limit', 2000)])[:LIMIT]
    if name == 'cc_ls':
        return '\n'.join(entry.name + ('/' if entry.is_dir() else '') for entry in sorted(file.iterdir())[:500])
    if name in ('cc_write', 'cc_edit'):
        value = args.get('content')
        if name == 'cc_edit':
            value = read(file)
            if not args['oldText'] or value.count(args['oldText']) != 1:
                raise ValueError('oldText must match exactly once')
            value = value.replace(args['oldText'], args['newText'], 1)
        if not isinstance(value, str) or len(value.encode()) > LIMIT:
            raise ValueError('Write is limited to 2 MiB')
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(value)
        return f'Updated {file}'
    if name in ('cc_find', 'cc_grep'):
        matches, visited = [], 0
        for directory, dirs, files in os.walk(file, followlinks=False):
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('node_modules', '__pycache__') and not (Path(directory) / d).is_symlink()]
            for entry in files:
                visited += 1
                candidate = Path(directory) / entry
                if entry.startswith('.') or candidate.is_symlink() or not candidate.is_file():
                    continue
                relative = str(candidate.relative_to(file))
                if name == 'cc_find':
                    if args['pattern'] in relative:
                        matches.append(relative)
                elif candidate.stat().st_size <= LIMIT:
                    try:
                        for index, line in enumerate(read(target(str(candidate))).splitlines(), 1):
                            if args['pattern'] in line:
                                matches.append(f'{relative}:{index}: {line[:500]}')
                                if len(matches) >= 200:
                                    break
                    except (UnicodeError, ValueError):
                        pass
                if visited >= 10000 or len(matches) >= 200:
                    return '\n'.join(matches[:200]) + '\n[limited; narrow path]'
        return '\n'.join(matches)
    raise ValueError('Unknown file tool')


try:
    print(main(json.loads(sys.stdin.read(LIMIT * 2))))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
