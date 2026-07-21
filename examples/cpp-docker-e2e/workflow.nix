{
  pkgs,
  ccLib,
  projects,
}:

if !pkgs.stdenv.isLinux then
  { }
else
  let
    cppA = projects.cpp-a.packages.default;
    cppB = projects.cpp-b.packages.default;
    image = pkgs.dockerTools.buildLayeredImage {
      name = "cc-cpp-example";
      tag = "local";
      contents = [
        pkgs.busybox
        cppA
        cppB
      ];
      config.Cmd = [
        "${pkgs.busybox}/bin/sh"
        "-euc"
        ''
          mkdir -p /srv
          { ${cppA}/bin/cpp-a; ${cppB}/bin/cpp-b; } > /srv/health
          exec ${pkgs.busybox}/bin/httpd -f -p 8080 -h /srv
        ''
      ];
    };
    e2e = pkgs.writeShellApplication {
      name = "cc-cpp-docker-e2e";
      runtimeInputs = [
        pkgs.coreutils
        pkgs.curl
        pkgs.docker
        pkgs.gnugrep
        pkgs.gnused
      ];
      text = ''
        docker load < ${image}
        container_id="$(docker run --rm -d -p 127.0.0.1::8080 cc-cpp-example:local)"
        cleanup() {
          docker rm -f "$container_id" >/dev/null 2>&1 || true
        }
        trap cleanup EXIT

        port="$(docker port "$container_id" 8080/tcp | sed 's/.*://')"
        output=""
        for _ in $(seq 1 40); do
          if output="$(curl --fail --silent "http://127.0.0.1:$port/health")"; then
            break
          fi
          sleep 0.25
        done

        test -n "$output"
        grep -Fx 'cpp-a ready' <<< "$output"
        grep -Fx 'cpp-b ready' <<< "$output"
      '';
    };
  in
  {
    cpp-docker-e2e = ccLib.mkWorkflow {
      name = "cpp-docker-e2e";
      artifacts.image = image;
      checks.image = image;
      apps.e2e = ccLib.mkApp e2e "cc-cpp-docker-e2e";
      metadata = {
        summary = "Build two C++ projects, compose an HTTP service image, then verify it end to end.";
        runtime = "docker";
      };
    };
  }
