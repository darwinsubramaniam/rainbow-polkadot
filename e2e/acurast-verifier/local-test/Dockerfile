# The processor's starting conditions, reproduced closely enough to be useful.
#
# The point of this image is what it does NOT contain. The proot Ubuntu rootfs
# an Acurast Shell job unpacks has no curl and no node, and that emptiness is
# the single most expensive thing about the environment: it is the window in
# which the job cannot report, and where runs 380398 and 380401 died leaving
# nothing behind. An image with curl preinstalled would skip the only part of
# start.sh that has actually been failing.
#
# So: do not add curl. Do not add node. Let start.sh earn them.

ARG BASE=ubuntu:questing
FROM ${BASE}

# GOTCHA 1, reproduced deliberately. The executor leaks its Android cache path
# as TMPDIR and that path does not exist inside the rootfs, so every mktemp-based
# tool breaks and apt exits 100. start.sh must overwrite this on its first line;
# if that line is ever removed, this image is what catches it.
ENV TMPDIR=/data/data/com.acurast.executor/cache/does-not-exist

# The bundle is extracted to /root/app on a processor, which IS $HOME/app — the
# case that once turned the staging step into `cp X X`. Same layout here.
ENV HOME=/root
WORKDIR /root

# procps gives us pkill for the stray-killer; the real rootfs gets it from the
# same apt stage start.sh runs, so installing it here does not hide anything
# that start.sh is responsible for.
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*

CMD ["/bin/sh", "/root/app/start.sh"]
