{ lib }:
let
  prefixAttrs =
    prefix: attrs:
    lib.mapAttrs' (name: value: lib.nameValuePair "${prefix}-${name}" value) attrs;

  ensureDerivations =
    label: attrs:
    assert lib.assertMsg (lib.isAttrs attrs) "${label} must be an attribute set";
    assert lib.assertMsg (
      lib.all lib.isDerivation (lib.attrValues attrs)
    ) "every ${label} value must be a derivation";
    attrs;

  validApp = app: lib.isAttrs app && (app.type or null) == "app" && app ? program;

  ensureApps =
    label: attrs:
    assert lib.assertMsg (lib.isAttrs attrs) "${label} must be an attribute set";
    assert lib.assertMsg (lib.all validApp (lib.attrValues attrs)) "every ${label} value must be a flake app";
    attrs;

  hasEntries = attrs: builtins.length (lib.attrNames attrs) > 0;
in
rec {
  mkApp = package: program: {
    type = "app";
    program = "${package}/bin/${program}";
  };

  mkProject =
    {
      name,
      src,
      packages ? { },
      checks ? { },
      apps ? { },
      metadata ? { },
    }:
    assert lib.assertMsg (name != "") "project name must not be empty";
    assert lib.assertMsg (hasEntries packages || hasEntries checks || hasEntries apps) (
      "project ${name} must expose at least one package, check or app"
    );
    {
      inherit name src metadata;
      packages = ensureDerivations "project ${name} packages" packages;
      checks = ensureDerivations "project ${name} checks" checks;
      apps = ensureApps "project ${name} apps" apps;
    };

  mkWorkflow =
    {
      name,
      artifacts ? { },
      checks ? { },
      apps ? { },
      metadata ? { },
    }:
    assert lib.assertMsg (name != "") "workflow name must not be empty";
    assert lib.assertMsg (hasEntries artifacts || hasEntries checks || hasEntries apps) (
      "workflow ${name} must expose at least one artifact, check or app"
    );
    {
      inherit name metadata;
      artifacts = ensureDerivations "workflow ${name} artifacts" artifacts;
      checks = ensureDerivations "workflow ${name} checks" checks;
      apps = ensureApps "workflow ${name} apps" apps;
    };

  collect =
    field: definitions:
    lib.foldl'
      (
        result: name:
        result // prefixAttrs name (definitions.${name}.${field} or { })
      )
      { }
      (lib.attrNames definitions);
}
