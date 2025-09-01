ARG BASE=nvidia/cuda:13.0.0-cudnn-devel-ubuntu24.04
FROM ${BASE}

RUN apt-get update --fix-missing && \
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
      screen \
      stow \
      sudo \
      vim \
      zsh && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /root/.cache

ARG USER=wangtianshu
ARG USER_SHELL=/bin/zsh
ARG UID=1000
ARG GID=100
RUN id -u ${USER} >/dev/null 2>&1 || { \
    id -u ubuntu >/dev/null 2>&1 && userdel -r ubuntu; \
    useradd -m -u ${UID} -g ${GID} -s ${USER_SHELL} -p '*' -N ${USER}; \
    echo ${USER}" ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers; }

RUN --mount=type=cache,uid=${UID},gid=${GID},target=/home/${USER}/.cache \
    su - ${USER} -c 'cd ~ && \
    git clone --recurse-submodules https://github.com/tshu-w/dotfiles.git && \
    cd dotfiles && make && exec zsh -i'
