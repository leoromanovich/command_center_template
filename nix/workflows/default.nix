{
  pkgs,
  ccLib,
  projects,
}:

# Cross-project workflows consume project outputs; they do not rebuild projects ad hoc.
import ../../examples/cpp-docker-e2e/workflow.nix { inherit pkgs ccLib projects; }

