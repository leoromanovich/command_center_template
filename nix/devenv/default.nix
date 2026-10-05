{
  pkgs,
  ccLib,
  inputs,
}:
let
  # Keep the CLI and module schema aligned when updating either flake input.
  devenv =
    assert pkgs.lib.assertMsg (
      pkgs.devenv.src.outputHash == inputs.devenv.narHash
    ) "devenv CLI and module input must use the same source revision";
    pkgs.devenv;
  python = pkgs.python3.withPackages (p: [ p.psycopg ]);
  api = pkgs.writeShellApplication {
    name = "cc-pilot-api";
    text = ''
      exec ${python}/bin/python ${inputs.pilot-src}/api.py "$@"
    '';
  };
  module = pkgs.writeText "cc-pilot-devenv.nix" ''
    import ${../../examples/devenv}/devenv.nix {
      api = ${api};
    }
  '';
  # Store paths are generated from flake inputs; no independent remote lock.
  yaml = pkgs.writeText "cc-pilot-devenv.yaml" (
    builtins.toJSON {
      inputs = {
        nixpkgs.url = "path:${inputs.nixpkgs}";
        devenv.url = "path:${inputs.devenv}/src/modules";
      };
      clean = {
        enabled = true;
        keep = [
          "USER"
          "HOME"
          "TMPDIR"
        ];
      };
    }
  );
  runner = pkgs.writeShellApplication {
    name = "cc-devenv-pilot";
    runtimeInputs = [
      devenv
      pkgs.python3
      pkgs.gitMinimal
    ];
    text = ''
      exec ${pkgs.python3}/bin/python ${./runner.py} \
        --devenv ${devenv}/bin/devenv --module ${module} --yaml ${yaml} "$@"
    '';
  };
  test = pkgs.writeShellApplication {
    name = "cc-devenv-pilot-test";
    text = ''exec ${runner}/bin/cc-devenv-pilot test "$@"'';
  };
  verify = pkgs.writeShellApplication {
    name = "cc-devenv-pilot-verify";
    runtimeInputs = [
      pkgs.gitMinimal
      pkgs.nix
      pkgs.python3
      pkgs.bash
      pkgs.coreutils
    ];
    text = ''
      exec ${pkgs.python3}/bin/python ${../../examples/devenv/verify.py} ${inputs.self}
    '';
  };
  projects.devenv-pilot = ccLib.mkProject {
    name = "devenv-pilot";
    src = inputs.pilot-src;
    packages.api = api;
    checks = {
      build = api;
      launcher = runner;
    };
    apps = {
      dev = ccLib.mkApp runner "cc-devenv-pilot";
      test = ccLib.mkApp test "cc-devenv-pilot-test";
      verify = ccLib.mkApp verify "cc-devenv-pilot-verify";
    };
    metadata.role = "example";
  };
in
{
  packages = {
    inherit devenv;
  }
  // ccLib.collect "packages" projects;
  checks = ccLib.collect "checks" projects;
  apps = ccLib.collect "apps" projects;
}
