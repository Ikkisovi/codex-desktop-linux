#!/usr/bin/env bash
set -euo pipefail

OPT_ROOT="${HOME}/.local/opt/codex-desktop-linux"
APP_DIR="${OPT_ROOT}/codex-app"
DMG_FILE="${OPT_ROOT}/Codex.dmg"
DMG_URL="https://persistent.oaistatic.com/codex-app-prod/Codex.dmg"

XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"

DATA_DIR="${XDG_DATA_HOME}/codex-desktop-linux"
STATE_DIR="${XDG_STATE_HOME}/codex-desktop-linux"
LOG_DIR="${STATE_DIR}/logs"
METADATA_FILE="${STATE_DIR}/metadata.env"
INSTALL_CONFIG_FILE="${STATE_DIR}/install.env"
ICON_PATH="${XDG_DATA_HOME}/icons/hicolor/512x512/apps/codex-desktop.png"
DESKTOP_FILE="${XDG_DATA_HOME}/applications/codex-desktop.desktop"

REPO_DIR_DEFAULT="${HOME}/workspace/codex-desktop-linux"
SOURCE_REPO_DIR="$REPO_DIR_DEFAULT"
MANAGED_REPO_DIR="${DATA_DIR}/managed-repo"
BUILD_REPO_DIR=""

ensure_layout() {
    mkdir -p "$DATA_DIR" "$STATE_DIR" "$LOG_DIR" "$(dirname "$ICON_PATH")" "$(dirname "$DESKTOP_FILE")"
}

load_install_config() {
    if [ -f "$INSTALL_CONFIG_FILE" ]; then
        # shellcheck disable=SC1090
        source "$INSTALL_CONFIG_FILE"
    fi
    SOURCE_REPO_DIR="${SOURCE_REPO_DIR:-${REPO_DIR:-$REPO_DIR_DEFAULT}}"
    REPO_DIR="$SOURCE_REPO_DIR"
    MANAGED_REPO_DIR="${MANAGED_REPO_DIR:-${DATA_DIR}/managed-repo}"
    REPO_DEFAULT_BRANCH="${REPO_DEFAULT_BRANCH:-main}"
}

load_metadata() {
    if [ -f "$METADATA_FILE" ]; then
        # shellcheck disable=SC1090
        source "$METADATA_FILE"
    fi
}

write_kv() {
    printf '%s=%q\n' "$1" "${2-}"
}

effective_repo_dir() {
    if [ -n "${BUILD_REPO_DIR:-}" ] && [ -d "$BUILD_REPO_DIR/.git" ]; then
        printf '%s\n' "$BUILD_REPO_DIR"
        return 0
    fi
    if [ -d "$MANAGED_REPO_DIR/.git" ]; then
        printf '%s\n' "$MANAGED_REPO_DIR"
        return 0
    fi
    printf '%s\n' "$SOURCE_REPO_DIR"
}

current_repo_head() {
    local repo_dir
    repo_dir="$(effective_repo_dir)"
    git -C "$repo_dir" rev-parse HEAD
}

remote_repo_head() {
    local origin_url
    origin_url="$(repo_origin_url)" || return 1
    git ls-remote "$origin_url" HEAD | awk 'NR==1 { print $1 }'
}

repo_origin_url() {
    if [ -n "${REPO_ORIGIN_URL:-}" ]; then
        printf '%s\n' "$REPO_ORIGIN_URL"
        return 0
    fi
    if [ -d "$SOURCE_REPO_DIR/.git" ]; then
        git -C "$SOURCE_REPO_DIR" remote get-url origin
        return 0
    fi
    return 1
}

repo_default_branch() {
    local branch="${REPO_DEFAULT_BRANCH:-}"
    if [ -n "$branch" ] && [ "$branch" != "origin/HEAD" ]; then
        printf '%s\n' "$branch"
        return 0
    fi

    if [ -d "$SOURCE_REPO_DIR/.git" ]; then
        branch="$(git -C "$SOURCE_REPO_DIR" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
        branch="${branch#origin/}"
        if [ -n "$branch" ]; then
            printf '%s\n' "$branch"
            return 0
        fi
    fi

    printf '%s\n' "main"
}

source_repo_has_overlay() {
    [ -d "$SOURCE_REPO_DIR/.git" ] || return 1
    ! git -C "$SOURCE_REPO_DIR" diff --quiet --no-ext-diff HEAD --
}

ensure_managed_repo() {
    local origin_url branch
    origin_url="$(repo_origin_url)" || return 1
    branch="$(repo_default_branch)"

    mkdir -p "$(dirname "$MANAGED_REPO_DIR")"
    if [ -d "$MANAGED_REPO_DIR/.git" ]; then
        git -C "$MANAGED_REPO_DIR" remote set-url origin "$origin_url"
        return 0
    fi

    rm -rf "$MANAGED_REPO_DIR"
    git clone --origin origin --branch "$branch" --single-branch "$origin_url" "$MANAGED_REPO_DIR" >/dev/null 2>&1 \
        || git clone --origin origin "$origin_url" "$MANAGED_REPO_DIR" >/dev/null
}

apply_source_overlay() {
    local path target_path
    source_repo_has_overlay || return 0

    while IFS= read -r path; do
        [ -n "$path" ] || continue
        target_path="$MANAGED_REPO_DIR/$path"
        mkdir -p "$(dirname "$target_path")"
        rm -rf "$target_path"
        cp -a "$SOURCE_REPO_DIR/$path" "$target_path"
    done < <(git -C "$SOURCE_REPO_DIR" diff --name-only --diff-filter=ACMRTUXB HEAD --)

    while IFS= read -r path; do
        [ -n "$path" ] || continue
        rm -rf "$MANAGED_REPO_DIR/$path"
    done < <(git -C "$SOURCE_REPO_DIR" diff --name-only --diff-filter=D HEAD --)
}

prepare_build_repo() {
    local branch managed_ref

    load_install_config
    if ! repo_origin_url >/dev/null 2>&1; then
        BUILD_REPO_DIR="$SOURCE_REPO_DIR"
        return 0
    fi

    ensure_managed_repo
    branch="$(repo_default_branch)"
    managed_ref="origin/$branch"

    git -C "$MANAGED_REPO_DIR" reset --hard >/dev/null
    git -C "$MANAGED_REPO_DIR" clean -fdx >/dev/null
    git -C "$MANAGED_REPO_DIR" fetch --prune origin
    if git -C "$MANAGED_REPO_DIR" show-ref --verify --quiet "refs/heads/$branch"; then
        git -C "$MANAGED_REPO_DIR" checkout -q "$branch"
    else
        git -C "$MANAGED_REPO_DIR" checkout -q -B "$branch" "$managed_ref"
    fi
    git -C "$MANAGED_REPO_DIR" reset --hard "$managed_ref" >/dev/null
    git -C "$MANAGED_REPO_DIR" clean -fdx >/dev/null
    apply_source_overlay
    BUILD_REPO_DIR="$MANAGED_REPO_DIR"
}

remote_dmg_headers() {
    curl -fsSIL "$DMG_URL" | tr -d '\r'
}

header_value() {
    local headers="$1"
    local name="$2"
    printf '%s\n' "$headers" | awk -F': ' -v target="$name" 'tolower($1) == tolower(target) { print $2; exit }'
}

extract_icon() {
    ensure_layout
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    trap 'rm -rf "$tmp_dir"' RETURN

    7z e -y "$DMG_FILE" "Codex Installer/Codex.app/Contents/Resources/electron.icns" "-o${tmp_dir}" >/dev/null
    python3 - "$tmp_dir/electron.icns" "$ICON_PATH" <<'PY'
from PIL import Image
import sys

source_path, target_path = sys.argv[1], sys.argv[2]
with Image.open(source_path) as img:
    img.load()
    img.thumbnail((512, 512))
    img.save(target_path, format="PNG")
PY
}

record_metadata() {
    ensure_layout
    load_install_config

    local build_repo_dir repo_head dmg_sha256 dmg_size electron_version dmg_headers dmg_etag dmg_last_modified dmg_content_length build_time repo_origin
    build_repo_dir="$(effective_repo_dir)"

    if [ -d "$build_repo_dir/.git" ]; then
        repo_head="$(current_repo_head)"
        repo_origin="$(repo_origin_url 2>/dev/null || git -C "$build_repo_dir" remote get-url origin 2>/dev/null || printf '%s' unavailable)"
    else
        repo_head="unavailable"
        repo_origin="unavailable"
    fi
    dmg_sha256="$(sha256sum "$DMG_FILE" | awk '{ print $1 }')"
    dmg_size="$(stat -c '%s' "$DMG_FILE")"
    electron_version="$(cat "$APP_DIR/version")"
    build_time="$(date -Iseconds)"

    dmg_headers="$(remote_dmg_headers 2>/dev/null || true)"
    dmg_etag="$(header_value "$dmg_headers" "etag")"
    dmg_last_modified="$(header_value "$dmg_headers" "last-modified")"
    dmg_content_length="$(header_value "$dmg_headers" "content-length")"

    {
        write_kv BUILD_TIME "$build_time"
        write_kv REPO_ORIGIN "$repo_origin"
        write_kv REPO_HEAD "$repo_head"
        write_kv DMG_SHA256 "$dmg_sha256"
        write_kv DMG_SIZE "$dmg_size"
        write_kv DMG_ETAG "$dmg_etag"
        write_kv DMG_LAST_MODIFIED "$dmg_last_modified"
        write_kv DMG_CONTENT_LENGTH "$dmg_content_length"
        write_kv ELECTRON_VERSION "$electron_version"
        write_kv APP_DIR "$APP_DIR"
        write_kv ICON_PATH "$ICON_PATH"
        write_kv OPT_ROOT "$OPT_ROOT"
        write_kv REPO_DIR "$build_repo_dir"
        write_kv SOURCE_REPO_DIR "$SOURCE_REPO_DIR"
        write_kv MANAGED_REPO_DIR "$MANAGED_REPO_DIR"
    } > "$METADATA_FILE"
}
