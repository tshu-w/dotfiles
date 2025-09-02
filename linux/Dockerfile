ARG BASE=nvidia/cuda:13.0.0-cudnn-devel-ubuntu24.04
FROM ${BASE}

ARG TZ=Asia/Shanghai
ENV TZ=${TZ}
RUN --mount=type=cache,id=apt_cache,target=/var/cache/apt \
    --mount=type=cache,id=apt_lists,target=/var/lib/apt/lists \
    DEBIAN_FRONTEND=noninteractive \
    apt-get update --fix-missing && \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      cron \
      curl \
      git \
      git-lfs \
      less \
      locales \
      language-pack-en \
      netcat-openbsd \
      openssh-client \
      openssh-server \
      python3 \
      python3-pip \
      python-is-python3 \
      screen \
      stow \
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

ARG CACHEBUST=0
RUN --mount=type=cache,id=dot_cache,uid=${UID},gid=${GID},target=/home/${USER}/.cache \
    su - ${USER} -c 'cd ~ && \
    git clone --depth=1 --recurse-submodules https://github.com/tshu-w/dotfiles.git && \
    cd dotfiles && make && zsh -lic "true"'
