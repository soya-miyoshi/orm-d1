# d1zzle devcontainer.
#
# Deliberately leaner than the sibling product repo's image: this package has no
# browser tests, no payment CLI and no native modules, so Playwright, Chromium,
# the Stripe CLI and the Python/build-essential toolchain are all absent. What is
# left is Node, a decent shell, git tooling and Claude Code.
#
# Architecture-agnostic on purpose (no `platform:` pin in compose): workerd,
# esbuild and tsgo all ship native arm64 builds, and running them emulated makes
# the workers test project several times slower on Apple Silicon.
FROM node:24-bookworm

ARG TZ=Asia/Tokyo
ARG GIT_DELTA_VERSION=0.18.2
ARG ZSH_IN_DOCKER_VERSION=1.2.0

# Timezone
ENV TZ=${TZ}
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# System packages, one layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    zsh \
    vim \
    sudo \
    less \
    # process management — `kp`-style port cleanup, hunting stray workerd
    lsof \
    procps \
    psmisc \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# git-delta — resolve the .deb for whichever architecture we are building for
RUN ARCH="$(dpkg --print-architecture)" \
    && wget -q "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" \
    && dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" \
    && rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# zsh-in-docker
RUN wget -q https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh \
    && sh zsh-in-docker.sh \
        -t robbyrussell \
        -p git \
        -p safe-paste \
        -p https://github.com/zsh-users/zsh-autosuggestions \
        -p https://github.com/zsh-users/zsh-syntax-highlighting \
    && rm zsh-in-docker.sh

# Workspace + persistent dirs.
#
# `node_modules` is created here on purpose: docker seeds a fresh named volume
# from the image path, ownership included, so this is what keeps the volume
# writable by `node` instead of landing root-owned.
RUN mkdir -p /workspace/node_modules /commandhistory /home/node/.claude \
    && chown -R node:node /workspace /commandhistory /home/node/.claude

# Symlink .claude.json into the mounted .claude/ directory
RUN ln -s /home/node/.claude/.claude.json /home/node/.claude.json \
    && chown -h node:node /home/node/.claude.json

# Passwordless sudo for dev-time apt installs
RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

# npm global prefix
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=/home/node/.local/bin:$NPM_CONFIG_PREFIX/bin:$PATH
RUN mkdir -p $NPM_CONFIG_PREFIX && chown -R node:node $NPM_CONFIG_PREFIX

# --- Everything below runs as node ---
USER node

# fzf
RUN git clone --depth 1 https://github.com/junegunn/fzf.git /home/node/.fzf \
    && /home/node/.fzf/install --all

# Shell config — source dotfiles/ if the host mounts one
RUN printf '%s\n' \
       '' \
       '# Load dotfiles mounted from host' \
       'if [ -d /home/node/dotfiles ]; then' \
       '  for f in /home/node/dotfiles/*.sh; do' \
       '    [ -r "$f" ] && . "$f"' \
       '  done' \
       '  unset f' \
       'fi' >> /home/node/.bashrc \
    && printf '%s\n' \
       '' \
       '# Load dotfiles mounted from host' \
       'if [ -d /home/node/dotfiles ]; then' \
       '  for f in /home/node/dotfiles/*.sh /home/node/dotfiles/*.zsh; do' \
       '    [ -r "$f" ] && . "$f"' \
       '  done' \
       '  unset f' \
       'fi' >> /home/node/.zshrc

# Claude Code
RUN curl -fsSL https://claude.ai/install.sh | bash

# Git config (delta + settings + identity)
RUN git config --global core.pager delta \
    && git config --global interactive.diffFilter "delta --color-only" \
    && git config --global delta.navigate true \
    && git config --global delta.side-by-side true \
    && git config --global init.defaultBranch main \
    && git config --global pull.rebase false \
    && git config --global push.autoSetupRemote true \
    && git config --global core.autocrlf input \
    && git config --global core.hooksPath /home/node/.git-hooks \
    && git config --global --add safe.directory /workspace \
    && git config --global user.email "soyamiyoshi@gmail.com" \
    && git config --global user.name "soya-miyoshi"

# Pre-push hook: pushing is a host operation, not a container one
RUN mkdir -p /home/node/.git-hooks \
    && printf '%s\n' '#!/bin/bash' 'echo "Push is disabled inside container. Run from host."' 'exit 1' \
       > /home/node/.git-hooks/pre-push \
    && chmod +x /home/node/.git-hooks/pre-push

ENV EDITOR=vim
WORKDIR /workspace
SHELL ["/bin/zsh", "-c"]
