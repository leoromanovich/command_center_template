{ api }:
{ config, pkgs, ... }:
{
  packages = [
    pkgs.python3
    pkgs.curl
    pkgs.devenv
  ];
  cachix.enable = false;
  services.postgres = {
    enable = true;
    package = pkgs.postgresql_17;
    listen_addresses = "127.0.0.1";
    initialDatabases = [ { name = "pilot"; } ];
  };
  env.PGDATABASE = "pilot";
  env.PILOT_PORT = toString config.processes.api.ports.http.value;
  processes.api = {
    exec = "${api}/bin/cc-pilot-api";
    ports.http.allocate = 18080;
    after = [ "devenv:processes:postgres@ready" ];
    ready.http.get = {
      host = "127.0.0.1";
      port = config.processes.api.ports.http.value;
      path = "/health";
    };
  };
  enterTest = ''
    {
      wait_for_processes 120
      ${pkgs.python3}/bin/python ${./test_runtime.py}
    } > "$DEVENV_ROOT/test.log" 2>&1
  '';
}
