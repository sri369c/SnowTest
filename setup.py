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
    ./setup.py down        # stop the container; nothing is removed
    ./setup.py build       # rebuild the image
    ./setup.py redeploy    # replace the container and image, clear stages, seed again

Podman is preferred when both are installed; `--engine docker` forces Docker.
Anything after `--` is appended to the server command line:

    ./setup.py up -- --verbose

Several instances can run side by side: `--name` (default `snowtest`) names
the container and derives its data volume (`<name>-data`) and stage directory
(`<repo>/.snowtest/<name>/stages`); give each its own `--port`.

Data persists across restarts in the `<name>-data` volume
(`SNOWTEST_DATA_DIR`); `--no-persist` keeps it in memory instead.

The stage directory is bind-mounted at the
*same absolute path* inside the container, so `PUT` / `GET` work with a client
running on the host, which is what dbt does. On Windows the drive letter is
dropped (C:\\x -> /x), so the client must run with the stage's drive current.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_NAME = "snowtest"
CONTAINER_PORT = 3030
DEFAULT_PORT = 3030


def _package_version() -> str:
    """The image tag follows package.json, so a release bump has one place to change."""
    try:
        return str(json.loads((PROJECT_ROOT / "package.json").read_text(encoding="utf-8"))["version"])
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"setup.py: could not read the version from package.json: {exc}", file=sys.stderr)
        raise SystemExit(1)


DEFAULT_VERSION = _package_version()
DEFAULT_IMAGE = f"snowtest:{DEFAULT_VERSION}"
DEFAULT_NETWORK = "snowtest-network"
DATA_MOUNT = "/var/lib/snowtest/data"
ACCOUNT = "SNOWTEST"
DATABASE = "SNOWTEST"
WAREHOUSE = "SNOWTEST_WH"

# Container, network and volume names: what podman and docker both accept.
NAME_PATTERN = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*")

EXAMPLES_SQL = PROJECT_ROOT / "data" / "examples.sql"
EXAMPLES_SCHEMA = f"{DATABASE}.EXAMPLES"

EXAMPLES = """\
examples:
  ./setup.py up
  ./setup.py up                      # start it, creating the container only if it is missing
  ./setup.py down                    # stop it; container, data volume and stages are kept
  ./setup.py redeploy                # after a code change: new container, clear stages, rebuild, seed
  ./setup.py redeploy --no-rebuild   # restart on the image already tagged
  ./setup.py redeploy --no-recreate  # keep the container; rebuild and seed only
  ./setup.py redeploy --no-seed-examples   # skip loading the bundled example tables
  ./setup.py redeploy --no-verify    # skip the self test that runs after seeding
  ./setup.py redeploy --public-key keys/rsa_key.pub --users DBT_SVC
  ./setup.py redeploy --port 9090 --write-profile ./dbt_project
  ./setup.py up --name team-a --port 3131 --network team-a-net   # a second, isolated instance
  ./setup.py up --no-persist         # in-memory: a restart is a clean slate
  ./setup.py up --dry-run            # print the podman commands, run nothing
  ./setup.py status                  # engine, store, machine, Desktop pipe, container state, health
  ./setup.py logs -f
  ./setup.py reset                   # clean slate between test runs
"""


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #


def die(message: str) -> "NoReturn":  # noqa: F821 - typing only
    print(f"setup.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def note(message: str) -> None:
    print(message)


def engine_name(value: str) -> str:
    """argparse type: a container, network or volume name."""
    if not NAME_PATTERN.fullmatch(value):
        raise argparse.ArgumentTypeError(
            f"invalid name {value!r}: use letters, digits, '_', '.' or '-', starting with a letter or digit")
    return value


def port_number(value: str) -> int:
    """argparse type: a TCP port."""
    if not value.isdigit() or not 1 <= int(value) <= 65535:
        raise argparse.ArgumentTypeError(f"invalid port {value!r}: expected 1-65535")
    return int(value)


def data_volume(args: argparse.Namespace) -> str:
    return f"{args.name}-data"


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
        path = PROJECT_ROOT / ".snowtest" / args.name / "stages"
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


def container_state(engine: str, args: argparse.Namespace) -> str | None:
    """'running', 'exited', ... or None when there is no such container."""
    if args.dry_run:
        return None
    proc = subprocess.run(
        [engine, "inspect", "--format", "{{.State.Status}}", args.name],
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def engine_store(engine: str, args: argparse.Namespace) -> str:
    """Which store the engine is using, and whether it is the rootless one.

    Two stores live in one podman machine, so "where did this deploy go?" is a
    real question; `status` answers it instead of leaving the user to guess.
    These fields are engine-specific: `.Store.GraphRoot` and
    `.Host.Security.Rootless` do not exist in docker's info, whose single store
    is `.DockerRootDir`.
    """
    template = (
        "{{.Store.GraphRoot}} ({{if .Host.Security.Rootless}}rootless{{else}}rootful{{end}})"
        if engine == "podman"
        else "{{.DockerRootDir}}"
    )
    value = run(
        [engine, "info", "--format", template],
        capture=True, echo=False, check=False, dry=args.dry_run,
    )
    return value.strip() or "unknown"


def machine_info(engine: str, args: argparse.Namespace) -> tuple[str, str] | None:
    """Name and state of the podman machine behind this engine, if any."""
    if engine != "podman":
        return None
    listing = run(
        [engine, "machine", "list", "--format", "{{.Name}}\t{{.Running}}"],
        capture=True, echo=False, check=False, dry=args.dry_run,
    )
    for line in listing.splitlines():
        name, _, running = line.partition("\t")
        name = name.strip().rstrip("*")
        if name:
            return name, ("running" if running.strip().lower() == "true" else "stopped")
    return None


def windows_pipe_state(machine: str) -> str | None:
    """Whether the named pipe a GUI client connects to exists.

    Returns None when there is nothing to check (other platforms), so callers can
    tell "no pipe here" apart from "pipe broken".
    """
    if os.name != "nt":
        return None
    try:
        import ctypes

        exists = bool(ctypes.windll.kernel32.WaitNamedPipeW(f"\\\\.\\pipe\\{machine}", 0))
    except (OSError, AttributeError):
        return "unknown"
    return "ok" if exists else "missing (Podman Desktop cannot connect)"


def inspect_value(engine: str, target: str, template: str,
                  args: argparse.Namespace) -> str | None:
    """One `inspect --format` field of a container or image, if it exists."""
    value = run(
        [engine, "inspect", "--format", template, target],
        capture=True, echo=False, check=False, dry=args.dry_run,
    )
    return value.strip() or None


def warn_if_image_moved(engine: str, args: argparse.Namespace) -> None:
    """Point out a running container that is on an older image than the tag.

    Rebuilding the tag does not touch a running container, so without this the
    tests quietly run yesterday's build.
    """
    if args.dry_run:
        return
    current = inspect_value(engine, args.name, "{{.Image}}", args)
    wanted = inspect_value(engine, args.image, "{{.Id}}", args)
    if not current or not wanted:
        return
    # Both are content IDs (`sha256:` plus the digest), so the first 19 characters
    # already identify the image without caring which form the engine printed.
    if current[:19] != wanted[:19]:
        note(f"  note: {args.name} is running an older image than {args.image}")
        note("        run ./setup.py redeploy to move it onto the current build")


def build_image(engine: str, image: str, args: argparse.Namespace,
                *, no_cache: bool = False) -> None:
    note(f"building {image} with {engine}")
    # Podman-only image hygiene: `--layers=false` keeps no intermediate (untagged)
    # images behind, so the image list stays free of `<none>` entries; the cost is
    # that every build reruns `npm ci` instead of reusing a cache. `--format docker`
    # is what records the Dockerfile's HEALTHCHECK, which podman's OCI default drops
    # silently. Docker's builder has neither flag, and records the health check anyway.
    cmd = [engine, "build"]
    if engine == "podman":
        cmd += ["--layers=false", "--format", "docker"]
    cmd += ["-t", image]
    if no_cache:
        cmd.append("--no-cache")
    cmd.append(str(PROJECT_ROOT))
    try:
        run(cmd, dry=args.dry_run)
    finally:
        # Belt and braces: a build that fails midway can still leave an untagged
        # layer behind, and dangling images are never wanted here.
        note("pruning dangling images")
        run([engine, "image", "prune", "-f"], dry=args.dry_run, check=False)
    # The prune above is the fix; this is the check that it kept working. A build
    # that leaves <none> entries is a failure here, not a cosmetic surprise.
    dangling = run(
        [engine, "image", "ls", "--filter", "dangling=true", "-q"],
        capture=True, echo=False, check=False, dry=args.dry_run,
    )
    if dangling.strip():
        die("the build left dangling images behind: " + ", ".join(dangling.split()[:5]))


def remove_container(engine: str, args: argparse.Namespace) -> bool:
    state = container_state(engine, args)
    if state is None and not args.dry_run:
        return False
    note(f"removing container {args.name} (state: {state or 'unknown'})")
    run([engine, "rm", "-f", args.name], dry=args.dry_run, check=False)
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
        "--name", args.name,
        "--network", args.network,
        "--restart", "unless-stopped",
        "-p", f"{args.bind}:{args.port}:{CONTAINER_PORT}",
        "-e", f"SNOWTEST_PORT={CONTAINER_PORT}",
        "-e", f"SNOWTEST_STAGE_ROOT={container_path(stage)}",
        *bind(stage, container_path(stage), args),
    ]
    if args.persist:
        # Named volume: created on first use, kept by `down` and `redeploy`.
        cmd += ["-v", f"{data_volume(args)}:{DATA_MOUNT}", "-e", f"SNOWTEST_DATA_DIR={DATA_MOUNT}"]
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
    """`load_examples` behind the `--seed-examples` switch, which `redeploy` owns."""
    if not args.seed_examples:
        return
    load_examples(args)


def load_examples(args: argparse.Namespace) -> None:
    """Load data/examples.sql. Tables are replaced, so reruns are safe."""
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
# self test
# --------------------------------------------------------------------------- #


def verify_instance(args: argparse.Namespace) -> None:
    """Ask the instance to check itself, and stop if it says no.

    The self test drives the same endpoints a client uses, so a pass is about the
    container that was just started rather than about the tree it was built from.
    It writes to a scratch database it drops again, apart from two rows in the
    fidelity ledger under `model.snowtest_selfcheck.*`.
    """
    url = base_url(args) + "/_snowtest/self-test"
    if args.dry_run:
        note(f"  # POST {url}, and fail if any check does")
        return
    note("verifying the instance with its own self test")
    try:
        report = http_json(url, method="POST", payload={}, timeout=120.0)
    except urllib.error.HTTPError as exc:
        # A 409 (a run already in flight) lands here too, and its body names the
        # reason: nothing was checked either way, which is a failure.
        detail = exc.read().decode(errors="replace")[:300]
        die(f"the self test did not run: HTTP {exc.code} {detail}")
    except (urllib.error.URLError, OSError) as exc:
        die(f"the self test did not run: {exc}")

    checks = report.get("checks") or []
    if not checks:
        die(f"the self test returned no report: {json.dumps(report)[:300]}")
    # The report's `ok` is "no check failed", computed from this same list, so the
    # list is the only thing worth reading: the checks that are printed and the
    # checks that are judged cannot then disagree.
    failed = [check for check in checks if not check.get("ok")]
    for check in failed:
        note(f"  FAIL  {check.get('name', '?')}: {check.get('passed', '?')}/{check.get('total', '?')} "
             f"{check.get('detail', '')}")
    if failed:
        die(f"the self test failed: {len(failed)} of {len(checks)} checks")
    note(f"  {report.get('passed')}/{report.get('total')} assertions in {len(checks)} checks "
         f"({report.get('durationMs', '?')} ms)")


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
    note(f"  endpoint   {base_url(args)}  (http://{args.name}:{CONTAINER_PORT} on {args.network})")
    note(f"  published  {args.bind}:{args.port} -> {CONTAINER_PORT}")
    note(f"  account    {ACCOUNT}   database {DATABASE}   warehouse {WAREHOUSE}")
    note(f"  stages     {stage}  (bind-mounted at {container_path(stage)} inside)")
    if args.persist:
        note(f"  data       volume {data_volume(args)} at {DATA_MOUNT} (survives restarts)")
    else:
        note("  data       in memory (a restart is a clean slate)")
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
    """Start the container, creating it only when it does not exist yet.

    Nothing here builds, seeds, replaces or clears: a stopped container is started
    in place, a running one is only probed. Everything that changes the deployment
    belongs to `redeploy`, so `up` cannot quietly discard a test's data.
    """
    engine = resolve_engine(args.engine, args.dry_run)
    stage = stage_directory(args)
    if not image_present(engine, args.image, args.dry_run):
        die(f"image {args.image} is not present; run ./setup.py build or ./setup.py redeploy first")

    def finish(created: bool) -> int:
        warn_if_image_moved(engine, args)
        health = wait_for_health(args)
        # Only a container this command created gets the example tables: a fresh
        # install then has something to query, and an instance that already holds a
        # test's data is never touched. Seeding replaces tables, so it is not
        # something `up` may do to a container it merely started.
        if created:
            note("new container: loading the example tables")
            load_examples(args)
        print_summary(args, stage, health)
        return 0

    state = container_state(engine, args)
    if state == "running":
        note(f"container {args.name} is already running; probing it")
        return finish(created=False)
    if state is not None:
        # A machine restart leaves the container stopped, not gone. Starting it in
        # place keeps its identity and its data.
        note(f"starting existing container {args.name} (state: {state})")
        run([engine, "start", args.name], dry=args.dry_run)
        return finish(created=False)

    create_container(engine, args, stage)
    return finish(created=True)


def cmd_redeploy(args: argparse.Namespace) -> int:
    """Replace the deployment: the container and the image, then the example data.

    Both halves default to on, so a bare `redeploy` picks up a code change. The
    switches are for leaving one out: `--no-rebuild` keeps the image already
    tagged, `--no-recreate` keeps the container that is already there.
    """
    engine = resolve_engine(args.engine, args.dry_run)
    stage = stage_directory(args)

    if args.recreate:
        state = container_state(engine, args)
        if state is None and not args.dry_run:
            note(f"no container named {args.name}; nothing to take down")
        else:
            remove_container(engine, args)

    if args.keep_stages:
        note(f"keeping staged files under {stage}")
    else:
        clear_stage_directory(stage, args)

    if args.rebuild or not image_present(engine, args.image, args.dry_run):
        build_image(engine, args.image, args, no_cache=args.no_cache)
    else:
        note(f"keeping {args.image}; --rebuild builds it again")

    state = container_state(engine, args)
    if state is None:
        create_container(engine, args, stage)
    elif state == "running":
        note(f"container {args.name} is still running; --recreate replaces it on the new image")
    else:
        note(f"starting existing container {args.name} (state: {state})")
        run([engine, "start", args.name], dry=args.dry_run)

    health = wait_for_health(args)
    if args.persist:
        note(f"data volume {data_volume(args)} is kept; ./setup.py reset clears it")
    else:
        note("the catalog is in memory, so this instance starts empty")
    seed_examples(args)
    # Before the summary, so a broken build ends on the failure, not on "up".
    if args.verify:
        verify_instance(args)
    print_summary(args, stage, health)
    maybe_write_profile(args)
    return 0


def cmd_down(args: argparse.Namespace) -> int:
    # Deliberate: `down` stops. It removes nothing — not the container, not the
    # data volume, not the stage files — so the next `up` is one second's work and
    # a test database is never lost to a stray command.
    engine = resolve_engine(args.engine, args.dry_run)
    state = container_state(engine, args)
    if state is None:
        note(f"no container named {args.name}")
        return 0
    if state != "running":
        note(f"container {args.name} is already stopped (state: {state})")
        return 0
    note(f"stopping container {args.name}")
    run([engine, "stop", args.name], dry=args.dry_run)
    note("the container, the data volume and the stage files are all kept;")
    note("`./setup.py redeploy` replaces it and `./setup.py reset` clears the data")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    """Everything needed to answer "is it deployed, and where?" in one screen."""
    candidates = ["podman", "docker"] if args.engine == "auto" else [args.engine]
    engine = next((name for name in candidates if shutil.which(name)), None)
    machine: tuple[str, str] | None = None
    pipe = None

    if engine:
        state = container_state(engine, args)
        note(f"engine     {engine}")
        machine = machine_info(engine, args)
        if machine:
            note(f"machine    {machine[0]}: {machine[1]}")
        note(f"store      {engine_store(engine, args)}")
        note(f"container  {args.name}: {state or 'not created'}")
        if state:
            ports = run(
                [engine, "port", args.name],
                capture=True, echo=False, check=False, dry=args.dry_run,
            ).strip()
            if ports:
                note(f"ports      {ports}")
            warn_if_image_moved(engine, args)
        if engine == "podman" and machine:
            pipe = windows_pipe_state(machine[0])
            if pipe is not None:
                note(f"pipe       \\\\.\\pipe\\{machine[0]}: {pipe}")
    else:
        note("engine     none installed (probing HTTP anyway)")

    try:
        health = http_json(base_url(args) + "/_snowtest/health", timeout=3.0)
        note(f"health     ok  {json.dumps(health)}")
        note(f"endpoint   {base_url(args)}")
        if pipe is not None and pipe != "ok":
            # A healthy container that no local client can reach is a failure, not
            # a detail: that is exactly how an empty Podman Desktop looks.
            note("problem    the container answers, but the machine's Windows pipe is missing,")
            note("           so GUI clients cannot see it. Restart the machine:")
            note("             podman machine stop && podman machine start")
            return 1
        return 0
    except (urllib.error.URLError, OSError) as exc:
        note(f"health     unreachable ({exc})")
        return 1


def cmd_logs(args: argparse.Namespace) -> int:
    engine = resolve_engine(args.engine, args.dry_run)
    cmd = [engine, "logs", "--tail", str(args.tail)]
    if args.follow:
        cmd.append("-f")
    cmd.append(args.name)
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
    parser.add_argument("--name", type=engine_name, default=DEFAULT_NAME,
                        help=f"container name; also names the data volume <name>-data and the stage "
                             f"directory .snowtest/<name>/stages (default: {DEFAULT_NAME})")
    parser.add_argument("--port", type=port_number, default=DEFAULT_PORT,
                        help=f"host port to publish (default: {DEFAULT_PORT})")
    parser.add_argument("--bind", default="127.0.0.1", metavar="ADDRESS",
                        help="host address to publish on (default: 127.0.0.1; "
                             "the control plane is unauthenticated, so 0.0.0.0 exposes it)")
    parser.add_argument("--network", type=engine_name, default=DEFAULT_NETWORK,
                        help=f"container network to join (default: {DEFAULT_NETWORK})")
    parser.add_argument("--persist", action=argparse.BooleanOptionalAction, default=True,
                        help="keep data in the <name>-data volume across restarts (default: on)")
    parser.add_argument("--stage-root", default=None,
                        help="host directory for stage files (default: <repo>/.snowtest/<name>/stages)")
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

    up = sub.add_parser("up", help="start the container, creating it if it does not exist")
    add_common(up)
    up.set_defaults(func=cmd_up)

    redeploy = sub.add_parser(
        "redeploy",
        help="replace the container and image after a code change (keeps the data volume)",
    )
    add_common(redeploy)
    redeploy.add_argument("--recreate", action=argparse.BooleanOptionalAction, default=True,
                          help="replace the container instead of reusing it (default: on)")
    redeploy.add_argument("--rebuild", action=argparse.BooleanOptionalAction, default=True,
                          help="rebuild the image before starting (default: on)")
    redeploy.add_argument("--no-cache", action="store_true", help="ignore the build cache")
    redeploy.add_argument("--keep-stages", action="store_true",
                          help="keep staged files instead of clearing them")
    redeploy.add_argument("--verify", action=argparse.BooleanOptionalAction, default=True,
                          help="run the instance's self test after seeding and fail if a check "
                               "fails (default: on)")
    redeploy.add_argument("--write-profile", default=None, metavar="DIR",
                          help="write DIR/profiles.yml for dbt")
    redeploy.add_argument("--force", action="store_true", help="overwrite an existing profiles.yml")
    add_seed_examples(redeploy)
    redeploy.set_defaults(func=cmd_redeploy)

    down = sub.add_parser("down", help="stop the container; nothing is removed")
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
