#!/usr/bin/env bash
set -euo pipefail
bundle_path=${1:-$HOME/Downloads/hellgraph_full_repo.bundle}
repo_dir=${2:-$HOME/dev/hellgraph}
remote_url=${3:-git@github.com:YOU/hellgraph.git}
mkdir -p "$(dirname "$repo_dir")"
cd "$(dirname "$repo_dir")"
git clone "$bundle_path" "$(basename "$repo_dir")"
cd "$repo_dir"
git remote add origin "$remote_url"
git push -u origin main
