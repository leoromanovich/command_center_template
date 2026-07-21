{
  pkgs,
  ccLib,
  src,
}:
let
  package = pkgs.stdenv.mkDerivation {
    pname = "replace-me";
    version = "0.1.0";
    inherit src;
    # nativeBuildInputs = [ pkgs.cmake ];
    # Configure build/install phases here; never duplicate them in Markdown.
  };
in
ccLib.mkProject {
  name = "replace-me";
  inherit src;
  packages.default = package;
  checks.build = package;
  metadata = {
    role = "replace-me";
    owner = "replace-me";
  };
}

