#!/usr/bin/env bash
# Runs FFmpeg from the cap-server image for hosts without FFmpeg installed.
# Paths under /tmp are shared with the container at the same location.
exec docker run --rm -i --network none --user "$(id -u):$(id -g)" -v /tmp:/tmp --entrypoint ffmpeg "${CAP_FFMPEG_IMAGE:-cap-server:dev}" "$@"
