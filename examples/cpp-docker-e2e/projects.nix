{ pkgs, ccLib }:
let
  mkCppProject =
    name: src:
    let
      package = pkgs.stdenv.mkDerivation {
        pname = name;
        version = "0.1.0";
        inherit src;
        nativeBuildInputs = [ pkgs.cmake ];
      };
    in
    ccLib.mkProject {
      inherit name src;
      packages.default = package;
      checks.build = package;
      metadata = {
        role = "example";
        owner = "template-user";
      };
    };
in
{
  cpp-a = mkCppProject "cpp-a" ./fixtures/cpp-a;
  cpp-b = mkCppProject "cpp-b" ./fixtures/cpp-b;
}

