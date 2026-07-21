{
  pkgs,
  ccLib,
  inputs ? { },
}:

# Replace this import with adapters that consume inputs.<repo-id>.
import ../../examples/cpp-docker-e2e/projects.nix { inherit pkgs ccLib; }
