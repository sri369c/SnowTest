#!/usr/bin/env python3
# Copyright (c) 2026 Srinivas Chaturvedula

"""snowtest container launcher.

This is a launcher, not a setuptools script: it has no build metadata and needs
no installation. Import it, run it, or copy it into a project. Standard library
only, so connecting a project to snowtest never starts with "install Python
packages".

    ./setup.py up          # build if needed, start, wait until healthy
    ./setup.py status      # container state + /_snowtest/health
    ./setup.py logs -f     # follow the server log
    ./setup.py reset       # between test runs: drop everything, recreate catalog
    ./setup.py down        # stop and remove the container
    ./setup.py build       # rebuild the image
    ./setup.py redeploy    # tear down, clear staged files, rebuild, start again

Podman is preferred when both are installed; `--engine docker` forces Docker.
Anything after `--` is appended to the server command line:

    ./setup.py up -- --verbose --port 3030

The stage directory (<repo>/.snowtest/stages by default) is bind-mounted at the
*same absolute path* inside the container, so `PUT` / `GET` work with a client
running on the host, which is what dbt does. On Windows the drive letter is
dropped (C:\\x -> /x), so the client must run with the stage's drive current.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
CONTAINER = "snowtest"
CONTAINER_PORT = 3030
DEFAULT_IMAGE = "snowtest:1.0.0"
DEFAULT_NETWORK = "snowtest-network"
ACCOUNT = "SNOWTEST"
DATABASE = "SNOWTEST"
WAREHOUSE = "SNOWTEST_WH"

EXAMPLES_SQL = PROJECT_ROOT / "data" / "examples.sql"
EXAMPLES_SCHEMA = f"{DATABASE}.EXAMPLES"

EXAMPLES = """\
examples:
  ./setup.py up
  ./setup.py up --public-key keys/rsa_key.pub --users DBT_SVC
  ./setup.py up --port 9090 --write-profile ./dbt_project
  ./setup.py up --dry-run            # print the podman commands, run nothing
  ./setup.py logs -f
  ./setup.py reset                   # clean slate between test runs
  ./setup.py redeploy                # pick up code changes: down, reset, build, up
  ./setup.py up --no-seed-examples   # skip loading the bundled example tables
  ./setup.py down
"""


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #


def die(message: str) -> "NoReturn":  # noqa: F821 - typing only
    print(f"setup.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def note(message: str) -> None:
    print(message)


def run(
    cmd: list[str],
    *,
    dry: bool = False,
    capture: bool = False,
    check: bool = True,
    echo: bool = True,
) -> str:
    """Run a command, printing it first so the log is reproducible."""
    printable = shlex.join(cmd)
    if dry:
        note(f"  $ {printable}")
        return ""
    if echo:
        note(f"  $ {printable}")
    proc = subprocess.run(
        cmd,
        text=True,
        capture_output=capture,
    )
    if check and proc.returncode != 0:
        if capture:
            detail = (proc.stderr or proc.stdout or "").strip()
            if detail:
                print(detail, file=sys.stderr)
        die(f"command failed with exit {proc.returncode}: {printable}")
    return (proc.stdout or "").strip() if capture else ""


def resolve_engine(requested: str, dry: bool) -> str:
    """Pick podman or docker. `auto` prefers podman."""
    candidates = ["podman", "docker"] if requested == "auto" else [requested]
    for name in candidates:
        if shutil.which(name):
            return name
    if dry:
        # Nothing to run anyway; show what would have been used.
        note(f"  # {candidates[0]} is not installed here; printing its commands anyway")
        return candidates[0]
    hint = (
        "install podman (https://podman.io) or docker:\n"
        "  Fedora/RHEL:    sudo dnf install podman\n"
        "  Debian/Ubuntu:  sudo apt install podman\n"
        "  macOS:          brew install podman && podman machine init && podman machine start"
    )
    die(f"no container engine found (looked for {', '.join(candidates)}).\n{hint}")


def selinux_enforcing() -> bool:
    try:
        return Path("/sys/fs/selinux/enforce").read_text().strip() == "1"
    except OSError:
        return False


def mount_suffix(args: argparse.Namespace, read_only: bool = False) -> str:
    opts: list[str] = []
    if read_only:
        opts.append("ro")
    if args.selinux == "on" or (args.selinux == "auto" and selinux_enforcing()):
        opts.append("Z")
    return ":" + ",".join(opts) if opts else ""


def container_path(host: Path) -> str:
    """Host path as seen inside the (Linux) container.

    Windows drops the drive (C:\\a\\b -> /a/b): the server echoes this path to the
    client for PUT/GET, and Windows resolves /a/b against the current drive.
    """
    if os.name != "nt":
        return str(host)
    return "/" + "/".join(host.parts[1:])


def bind(host: Path, target: str, args: argparse.Namespace,
         read_only: bool = False) -> list[str]:
    if os.name == "nt":
        # `-v C:\...:...` splits on the drive colon; --mount has no such ambiguity.
        spec = f"type=bind,source={host},target={target}"
        return ["--mount", spec + (",ro" if read_only else "")]
    return ["-v", f"{host}:{target}{mount_suffix(args, read_only)}"]


def stage_directory(args: argparse.Namespace) -> Path:
    if args.stage_root:
        path = Path(args.stage_root).expanduser()
    else:
        path = PROJECT_ROOT / ".snowtest" / "stages"
    path = path.resolve()
    if not args.dry_run:
        path.mkdir(parents=True, exist_ok=True)
    return path


def base_url(args: argparse.Namespace) -> str:
    return f"http://127.0.0.1:{args.port}"


# --------------------------------------------------------------------------- #
# HTTP (health / reset / status), all through the published port
# --------------------------------------------------------------------------- #


def http_json(url: str, method: str = "GET", payload: object | None = None,
              timeout: float = 5.0) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer setup",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode() or "{}"
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body}


def wait_for_health(args: argparse.Namespace) -> dict:
    url = base_url(args) + "/_snowtest/health"
    if args.dry_run:
        note(f"  # poll {url} until healthy (timeout {args.timeout}s)")
        return {"status": "ok", "dry-run": True}
    deadline = time.monotonic() + args.timeout
    last: object = "no response"
    while time.monotonic() < deadline:
        try:
            return http_json(url, timeout=2.0)
        except (urllib.error.URLError, OSError) as exc:
            last = exc
            time.sleep(0.4)
    die(f"{url} did not answer within {args.timeout}s ({last})")


# --------------------------------------------------------------------------- #
# image and container state
# --------------------------------------------------------------------------- #


def image_present(engine: str, image: str, dry: bool) -> bool:
    if dry:
        return True
    proc = subprocess.run(
        [engine, "image", "exists", image],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc.returncode == 0


def container_state(engine: str, dry: bool) -> str | None:
    """'running', 'exited', ... or None when there is no such container."""
    if dry:
        return None
    proc = subprocess.run(
        [engine, "inspect", "--format", "{{.State.Status}}", CONTAINER],
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def build_image(engine: str, image: str, args: argparse.Namespace,
                *, no_cache: bool = False) -> None:
    note(f"building {image} with {engine}")
    cmd = [engine, "build", "-t", image]
    if no_cache:
        cmd.append("--no-cache")
    cmd.append(str(PROJECT_ROOT))
    run(cmd, dry=args.dry_run)


def remove_container(engine: str, args: argparse.Namespace) -> bool:
    state = container_state(engine, args.dry_run)
    if state is None and not args.dry_run:
        return False
    note(f"removing container {CONTAINER} (state: {state or 'unknown'})")
    run([engine, "rm", "-f", CONTAINER], dry=args.dry_run, check=False)
    return True


def ensure_network(engine: str, args: argparse.Namespace) -> None:
    """Create the network if missing."""
    if args.dry_run:
        note(f"  # ensure network {args.network} exists")
        return
    names = run([engine, "network", "ls", "--format", "{{.Name}}"],
                capture=True, echo=False).splitlines()
    if args.network not in names:
        note(f"creating network {args.network}")
        run([engine, "network", "create", args.network])


def create_container(engine: str, args: argparse.Namespace, stage: Path) -> None:
    ensure_network(engine, args)
    cmd = [
        engine, "run", "-d",
        "--name", CONTAINER,
        "--network", args.network,
        "--restart", "unless-stopped",
        "-p", f"{args.port}:{CONTAINER_PORT}",
        "-e", f"SNOWTEST_PORT={CONTAINER_PORT}",
        "-e", f"SNOWTEST_STAGE_ROOT={container_path(stage)}",
        *bind(stage, container_path(stage), args),
    ]
    # Rootless podman: map the image's `node` user (uid/gid 1000) onto the
    # invoking user, so files written into the bind-mounted stage dir are ours.
    if engine == "podman" and args.userns in ("auto", "keep-id"):
        cmd += ["--userns=keep-id:uid=1000,gid=1000"]
    if args.public_key:
        key = Path(args.public_key).expanduser().resolve()
        if not key.is_file() and not args.dry_run:
            die(f"public key not found: {key}")
        cmd += [
            *bind(key, "/run/snowtest/public_key", args, read_only=True),
            "-e", "SNOWTEST_JWT_PUBLIC_KEY=/run/snowtest/public_key",
        ]
    if args.users:
        cmd += ["-e", f"SNOWTEST_USERS={args.users}"]
    for entry in args.env:
        cmd += ["-e", entry]
    cmd.append(args.image)
    cmd += args.extra
    run(cmd, dry=args.dry_run)


def clear_stage_directory(stage: Path, args: argparse.Namespace) -> None:
    """Empty the stage directory, keeping the directory itself."""
    if args.dry_run:
        note(f"  # clear {stage} (use --keep-stages to preserve staged files)")
        return
    entries = sorted(stage.iterdir()) if stage.is_dir() else []
    for entry in entries:
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()
    note(f"cleared {len(entries)} item(s) from {stage}")


# --------------------------------------------------------------------------- #
# example data
# --------------------------------------------------------------------------- #


def seed_examples(args: argparse.Namespace) -> None:
    """Load data/examples.sql. Tables are replaced, so reruns are safe."""
    if not args.seed_examples:
        return
    if args.dry_run:
        note(f"  # seed {EXAMPLES_SCHEMA} from {EXAMPLES_SQL}")
        return
    if not EXAMPLES_SQL.is_file():
        die(f"examples SQL not found: {EXAMPLES_SQL}")
    note(f"seeding example tables into {EXAMPLES_SCHEMA}")
    try:
        result = http_json(base_url(args) + "/_snowtest/seed", method="POST",
                           payload={"sql": EXAMPLES_SQL.read_text(encoding="utf-8")}, timeout=60.0)
    except urllib.error.HTTPError as exc:
        die(f"seeding examples failed: HTTP {exc.code} {exc.read().decode(errors='replace')[:500]}")
    except (urllib.error.URLError, OSError) as exc:
        die(f"seeding examples failed: {exc}")
    note(f"  executed {result.get('executed', '?')} statement(s)")


# --------------------------------------------------------------------------- #
# profile output
# --------------------------------------------------------------------------- #


def profile_yaml(args: argparse.Namespace) -> str:
    if args.public_key:
        auth = (
            "      user: DBT_SVC\n"
            "      authenticator: snowflake_jwt\n"
            "      private_key_path: /absolute/path/to/rsa_key.p8\n"
        )
    else:
        auth = "      user: test\n      password: test\n"
    return (
        "snowtest:\n"
        "  target: dev\n"
        "  outputs:\n"
        "    dev:\n"
        "      type: snowflake\n"
        f"      account: {ACCOUNT}\n"
        f"{auth}"
        f"      database: {DATABASE}\n"
        "      schema: PUBLIC\n"
        f"      warehouse: {WAREHOUSE}\n"
        "      role: SYSADMIN\n"
        "      threads: 4\n"
        "      host: 127.0.0.1\n"
        f"      port: {args.port}\n"
        "      protocol: http\n"
    )


def maybe_write_profile(args: argparse.Namespace) -> None:
    if not args.write_profile:
        return
    target_dir = Path(args.write_profile).expanduser().resolve()
    if args.dry_run:
        note(f"  # would write {target_dir / 'profiles.yml'}")
        return
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "profiles.yml"
    if target.exists() and not args.force:
        note(f"  {target} already exists; leaving it alone (--force overwrites)")
        return
    target.write_text(profile_yaml(args))
    note(f"  wrote {target}")


def print_summary(args: argparse.Namespace, stage: Path, health: dict) -> None:
    note("")
    note(f"snowtest is up.  (health: {health.get('status', '?')})")
    note("")
    note(f"  endpoint   {base_url(args)}  (http://{CONTAINER}:{CONTAINER_PORT} on {args.network})")
    note(f"  account    {ACCOUNT}   database {DATABASE}   warehouse {WAREHOUSE}")
    note(f"  stages     {stage}  (bind-mounted at {container_path(stage)} inside)")
    if args.public_key:
        note("  auth       key-pair, signatures verified")
    else:
        note("  auth       permissive: any user/password is accepted")
    note("")
    note("dbt profiles.yml:")
    note("")
    for line in profile_yaml(args).rstrip("\n").splitlines():
        note(f"  {line}")
    note("")
    note("stop it with ./setup.py down, or reset data between runs with ./setup.py reset")


# --------------------------------------------------------------------------- #
# subcommands
# --------------------------------------------------------------------------- #


def cmd_up(args: argparse.Namespace) -> int:
    engine = resolve_engine(args.engine, args.dry_run)
    stage = stage_directory(args)

    if args.rebuild or not image_present(engine, args.image, args.dry_run):
        build_image(engine, args.image, args)

    state = container_state(engine, args.dry_run)
    if state == "running" and not args.recreate:
        note(f"container {CONTAINER} is already running; probing it (use --recreate to restart)")
        health = wait_for_health(args)
        seed_examples(args)
        print_summary(args, stage, health)
        maybe_write_profile(args)
        return 0
    if state is not None:
        remove_container(engine, args)

    create_container(engine, args, stage)
    health = wait_for_health(args)
    seed_examples(args)
    print_summary(args, stage, health)
    maybe_write_profile(args)
    return 0


def cmd_redeploy(args: argparse.Namespace) -> int:
    """Take it down if it exists, reset it, rebuild the image, bring it up."""
    engine = resolve_engine(args.engine, args.dry_run)
    stage = stage_directory(args)

    state = container_state(engine, args.dry_run)
    if state is None and not args.dry_run:
        note(f"no container named {CONTAINER}; nothing to take down")
    else:
        remove_container(engine, args)

    if args.keep_stages:
        note(f"keeping staged files under {stage}")
    else:
        clear_stage_directory(stage, args)

    build_image(engine, args.image, args, no_cache=args.no_cache)
    create_container(engine, args, stage)
    health = wait_for_health(args)
    note("the catalog is in memory, so this instance starts empty")
    seed_examples(args)
    print_summary(args, stage, health)
    maybe_write_profile(args)
    return 0


def cmd_down(args: argparse.Namespace) -> int:
    engine = resolve_engine(args.engine, args.dry_run)
    if not remove_container(engine, args):
        note(f"no container named {CONTAINER}")
    else:
        note("stage files are kept; delete the stage directory if you want them gone")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    candidates = ["podman", "docker"] if args.engine == "auto" else [args.engine]
    engine = next((name for name in candidates if shutil.which(name)), None)

    if engine:
        state = container_state(engine, False)
        note(f"engine     {engine}")
        note(f"container  {CONTAINER}: {state or 'not created'}")
        if state:
            ports = subprocess.run(
                [engine, "port", CONTAINER],
                text=True, capture_output=True,
            ).stdout.strip()
            if ports:
                note(f"ports      {ports}")
    else:
        note("engine     none installed (probing HTTP anyway)")

    try:
        health = http_json(base_url(args) + "/_snowtest/health", timeout=3.0)
        note(f"health     ok  {json.dumps(health)}")
        note(f"endpoint   {base_url(args)}")
        return 0
    except (urllib.error.URLError, OSError) as exc:
        note(f"health     unreachable ({exc})")
        return 1


def cmd_logs(args: argparse.Namespace) -> int:
    engine = resolve_engine(args.engine, args.dry_run)
    cmd = [engine, "logs", "--tail", str(args.tail)]
    if args.follow:
        cmd.append("-f")
    cmd.append(CONTAINER)
    run(cmd, dry=args.dry_run)
    return 0


def cmd_reset(args: argparse.Namespace) -> int:
    url = base_url(args) + "/_snowtest/reset"
    if args.dry_run:
        note(f"  $ curl -s -X POST {url}")
        return 0
    try:
        result = http_json(url, method="POST", payload={}, timeout=10.0)
    except (urllib.error.URLError, OSError) as exc:
        die(f"reset failed: {exc}")
    note(f"reset: {json.dumps(result)}")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    engine = resolve_engine(args.engine, args.dry_run)
    build_image(engine, args.image, args, no_cache=args.no_cache)
    return 0


# --------------------------------------------------------------------------- #
# argument parsing
# --------------------------------------------------------------------------- #


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--engine", choices=("auto", "podman", "docker"), default="auto",
                        help="container engine; auto prefers podman (default: auto)")
    parser.add_argument("--image", default=DEFAULT_IMAGE, help=f"image tag (default: {DEFAULT_IMAGE})")
    parser.add_argument("--port", type=int, default=3030, help="host port to publish (default: 3030)")
    parser.add_argument("--network", default=DEFAULT_NETWORK,
                        help=f"container network to join (default: {DEFAULT_NETWORK})")
    parser.add_argument("--stage-root", default=None,
                        help="host directory for stage files (default: <repo>/.snowtest/stages)")
    parser.add_argument("--public-key", default=None,
                        help="PEM public key; enables verified key-pair login")
    parser.add_argument("--users", default=None,
                        help="comma-separated login allow-list (SNOWTEST_USERS)")
    parser.add_argument("--env", action="append", default=[], metavar="KEY=VALUE",
                        help="extra environment variable; repeatable")
    parser.add_argument("--selinux", choices=("auto", "on", "off"), default="auto",
                        help="add the :Z mount label (default: auto-detect)")
    parser.add_argument("--userns", choices=("auto", "keep-id", "none"), default="auto",
                        help="podman user-namespace mapping (default: auto = keep-id)")
    parser.add_argument("--timeout", type=int, default=60,
                        help="seconds to wait for /_snowtest/health (default: 60)")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the commands instead of running them")


def add_seed_examples(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--seed-examples", action=argparse.BooleanOptionalAction, default=True,
                        help=f"load data/examples.sql into {EXAMPLES_SCHEMA} (default: on)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="setup.py",
        description="Run snowtest in a Podman (or Docker) container.",
        epilog=EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    up = sub.add_parser("up", help="build if needed, start, and wait until healthy")
    add_common(up)
    up.add_argument("--recreate", action="store_true", help="replace an already-running container")
    up.add_argument("--rebuild", action="store_true", help="rebuild the image first")
    up.add_argument("--write-profile", default=None, metavar="DIR",
                    help="write DIR/profiles.yml for dbt")
    up.add_argument("--force", action="store_true", help="overwrite an existing profiles.yml")
    add_seed_examples(up)
    up.set_defaults(func=cmd_up)

    redeploy = sub.add_parser(
        "redeploy",
        help="take down, reset staged files, rebuild the image, start again",
    )
    add_common(redeploy)
    redeploy.add_argument("--no-cache", action="store_true", help="ignore the build cache")
    redeploy.add_argument("--keep-stages", action="store_true",
                          help="keep staged files instead of clearing them")
    redeploy.add_argument("--write-profile", default=None, metavar="DIR",
                          help="write DIR/profiles.yml for dbt")
    redeploy.add_argument("--force", action="store_true", help="overwrite an existing profiles.yml")
    add_seed_examples(redeploy)
    redeploy.set_defaults(func=cmd_redeploy)

    down = sub.add_parser("down", help="stop and remove the container")
    add_common(down)
    down.set_defaults(func=cmd_down)

    status = sub.add_parser("status", help="container state and health")
    add_common(status)
    status.set_defaults(func=cmd_status)

    logs = sub.add_parser("logs", help="show the server log")
    add_common(logs)
    logs.add_argument("-n", "--tail", type=int, default=100, help="lines to show (default: 100)")
    logs.add_argument("-f", "--follow", action="store_true", help="follow the log")
    logs.set_defaults(func=cmd_logs)

    reset = sub.add_parser("reset", help="drop all data and recreate the catalog")
    add_common(reset)
    reset.set_defaults(func=cmd_reset)

    build = sub.add_parser("build", help="build the image")
    add_common(build)
    build.add_argument("--no-cache", action="store_true", help="ignore the build cache")
    build.set_defaults(func=cmd_build)

    return parser


def main(argv: list[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    extra: list[str] = []
    if "--" in raw:
        split = raw.index("--")
        raw, extra = raw[:split], raw[split + 1 :]

    args = build_parser().parse_args(raw)
    args.extra = extra
    if args.env:
        for entry in args.env:
            if "=" not in entry:
                die(f"--env expects KEY=VALUE, got {entry!r}")

    os.umask(0o022)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        note("\ninterrupted")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
