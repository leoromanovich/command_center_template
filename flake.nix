{
  description = "Agent-facing control center template";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs =
    inputs@{ self, nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      mkSystem =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          ccLib = import ./nix/lib { inherit (pkgs) lib; };
          projects = import ./nix/projects { inherit pkgs ccLib inputs; };
          workflows = import ./nix/workflows { inherit pkgs ccLib projects; };
          validator = pkgs.writeShellApplication {
            name = "cc-validate";
            runtimeInputs = [ pkgs.python3 ];
            text = ''
              exec python3 ${self}/scripts/validate-knowledge.py "$PWD"
            '';
          };
        in
        {
          packages =
            ccLib.collect "packages" projects
            // ccLib.collect "artifacts" workflows;

          checks =
            {
              knowledge = pkgs.runCommand "control-center-knowledge" { } ''
                ${pkgs.python3}/bin/python ${self}/scripts/validate-knowledge.py ${self}
                touch "$out"
              '';
            }
            // pkgs.lib.optionalAttrs (builtins.pathExists "${toString ./.}/control-center.json") {
              bootstrap = pkgs.runCommand "control-center-bootstrap" { } ''
                ${pkgs.python3}/bin/python ${self}/scripts/validate-control-center.py ${self}
                touch "$out"
              '';
            }
            // ccLib.collect "checks" projects
            // ccLib.collect "checks" workflows;

          apps =
            {
              default = ccLib.mkApp validator "cc-validate";
              validate = ccLib.mkApp validator "cc-validate";
            }
            // ccLib.collect "apps" projects
            // ccLib.collect "apps" workflows;

          devShell = pkgs.mkShell {
            packages = [
              pkgs.git
              pkgs.nixfmt-rfc-style
              pkgs.python3
            ];
          };

          formatter = pkgs.nixfmt-rfc-style;
        };
      perSystem = forAllSystems mkSystem;
    in
    {
      packages = nixpkgs.lib.mapAttrs (_: value: value.packages) perSystem;
      checks = nixpkgs.lib.mapAttrs (_: value: value.checks) perSystem;
      apps = nixpkgs.lib.mapAttrs (_: value: value.apps) perSystem;
      devShells = nixpkgs.lib.mapAttrs (_: value: { default = value.devShell; }) perSystem;
      formatter = nixpkgs.lib.mapAttrs (_: value: value.formatter) perSystem;
    };
}
