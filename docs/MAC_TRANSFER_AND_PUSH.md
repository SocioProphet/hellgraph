# Mac transfer and push

Recommended paths:

## Preserve local git history
1. Download `hellgraph_full_repo.bundle` to `~/Downloads`.
2. Run:

```bash
author_name="YOUR NAME"
author_email="you@example.com"
mkdir -p ~/dev
cd ~/dev
git clone ~/Downloads/hellgraph_full_repo.bundle hellgraph
cd hellgraph
git config user.name "$author_name"
git config user.email "$author_email"
git remote add origin git@github.com:YOU/hellgraph.git
git push -u origin main
```

## Fresh git init from source archive
1. Download `hellgraph_full_source.zip` to `~/Downloads`.
2. Run:

```bash
repo_url="git@github.com:YOU/hellgraph.git"
author_name="YOUR NAME"
author_email="you@example.com"
mkdir -p ~/dev
cp ~/Downloads/hellgraph_full_source.zip ~/dev/
cd ~/dev
unzip -q hellgraph_full_source.zip
cd hellgraph
git init -b main
git config user.name "$author_name"
git config user.email "$author_email"
git add .
git commit -m "Initial HellGraph import"
git remote add origin "$repo_url"
git push -u origin main
```
