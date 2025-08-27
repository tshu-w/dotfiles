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
    rm -rf /root/.cache && \
    rm -rf /var/lib/apt/lists/*

ARG USER=wangtianshu
ARG SHELL=/bin/zsh
RUN id -u ${USER} >/dev/null 2>&1 || \
    ( useradd --password '*' --shell ${SHELL} --create-home ${USER} && \
    echo ${USER}" ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers )
