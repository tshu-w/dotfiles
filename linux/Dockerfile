ARG BASE=nvidia/cuda:13.0.0-cudnn-devel-ubuntu22.04

FROM ubuntu:22.04 AS user-bootstrap

RUN --mount=type=cache,id=apt_cache,target=/var/cache/apt \
    --mount=type=cache,id=apt_lists,target=/var/lib/apt/lists \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      cron \
      curl \
      git \
      sudo \
      zsh && \
    apt-get autoremove -y

ARG USER=wangtianshu
ARG USHELL=/bin/zsh
ARG UID=1000
ARG GID=100
RUN id -u ${USER} >/dev/null 2>&1 || { \
    id -u ubuntu >/dev/null 2>&1 && userdel -r ubuntu; \
    useradd -m -u ${UID} -g ${GID} -s ${USHELL} -p '*' -N ${USER}; \
    echo ${USER}" ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers; }

RUN su - ${USER} -c 'curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash'

ARG CACHEBUST=0
RUN --mount=type=cache,id=dot_cache,uid=${UID},gid=${GID},target=/home/${USER}/.cache \
    su - ${USER} -c 'cd ~ && \
    git clone --depth=1 --recurse-submodules https://github.com/tshu-w/dotfiles.git && \
    cd dotfiles && make && zsh -lic "true"'

FROM ${BASE} AS dev-env

ENV TZ=Asia/Shanghai
RUN --mount=type=cache,id=apt_cache,target=/var/cache/apt \
    --mount=type=cache,id=apt_lists,target=/var/lib/apt/lists \
    apt-get update --fix-missing && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      cron \
      curl \
      git \
      git-lfs \
      locales \
      netcat-openbsd \
      openssh-client \
      openssh-server \
      python3 \
      python3-pip \
      python-is-python3 \
      sudo \
      tzdata \
      vim \
      zsh && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone && \
    apt-get autoremove -y

ARG USER=wangtianshu
ARG USHELL=/bin/zsh
ARG UID=1000
ARG GID=100
RUN id -u ${USER} >/dev/null 2>&1 || { \
    id -u ubuntu >/dev/null 2>&1 && userdel -r ubuntu; \
    useradd -m -u ${UID} -g ${GID} -s ${USHELL} -p '*' -N ${USER}; \
    echo ${USER}" ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers; }

COPY --from=user-bootstrap /home/linuxbrew /home/linuxbrew
COPY --from=user-bootstrap /home/${USER} /home/${USER}
