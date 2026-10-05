{
  pkgs,
}:

let
  # Копия поддерева loopeng без машинного состояния: фильтр зеркалит loopeng/.gitignore.
  # Хэш store-пути меняется только при изменении кода движка; правки остальных
  # файлов CC и runtime-состояние инстанса (.pi/, WorkTree/, cc.local.json)
  # derivation не инвалидируют.
  loopengSrc = builtins.path {
    path = ../../loopeng;
    name = "loopeng";
    filter =
      path: type:
      let
        base = baseNameOf path;
        excludedDirs = [
          ".git"
          ".pi"
          ".local"
          "WorkTree"
          "wt"
          "node_modules"
          "__pycache__"
          ".ruff_cache"
          ".venv"
          "graphify-out"
          ".demo"
          ".docker-demo"
          ".docker-project"
          ".knowledge-project"
        ];
        excludedFiles = [
          "cc.local.json"
          "model-prices.local.json"
          ".DS_Store"
        ];
        isEnvFile = base == ".env" || (pkgs.lib.hasPrefix ".env." base && base != ".env.example");
      in
      !builtins.elem base excludedDirs && !builtins.elem base excludedFiles && !isEnvFile;
  };

  node = pkgs.nodejs_22;

  # node_modules для hermetic-тестов: FOD выполняет npm ci по закоммиченному
  # lockfile (сеть только здесь), результат пинится recursive-хэшем.
  npmDeps = pkgs.runCommand "loopeng-pi-node-modules" {
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = "sha256-6PgSMRah5Xqi1vxOzpfOtcGyF6cn/usFt8BZnowOxBg=";
    nativeBuildInputs = [ node ];
  } ''
    mkdir -p "$TMPDIR/pideps"
    cp ${./package.json} "$TMPDIR/pideps/package.json"
    cp ${./package-lock.json} "$TMPDIR/pideps/package-lock.json"
    export HOME="$TMPDIR"
    export npm_config_cafile="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    export NODE_EXTRA_CA_CERTS="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    (
      cd "$TMPDIR/pideps"
      npm ci --ignore-scripts --no-audit --no-fund
    )
    mkdir -p "$out"
    cp -R "$TMPDIR/pideps/node_modules" "$out/node_modules"
  '';

  unit = pkgs.runCommand "loopeng-unit" { } ''
    export PATH=${pkgs.lib.makeBinPath [
      node
      pkgs.git
    ]}:$PATH
    export HOME="$TMPDIR"
    export GIT_CONFIG_GLOBAL=/dev/null
    export GIT_CONFIG_NOSYSTEM=1
    export GIT_AUTHOR_NAME=loopeng-check
    export GIT_AUTHOR_EMAIL=loopeng-check@localhost
    export GIT_COMMITTER_NAME=loopeng-check
    export GIT_COMMITTER_EMAIL=loopeng-check@localhost
    export PI_PACKAGE_ROOT="${npmDeps}/node_modules/@earendil-works/pi-coding-agent"

    cp -r ${loopengSrc} repo
    chmod -R u+w repo
    cd repo

    node --test --test-concurrency=1 tests/*.test.mjs runtime/pi/tests/*.test.mjs

    cd runtime/core
    node --test --test-concurrency=1 tests/*.test.mjs

    touch "$out"
  '';

  buildImage = pkgs.writeShellApplication {
    name = "loopeng-build-image";
    runtimeInputs = [
      node
      pkgs.git
    ];
    text = ''
      exec ${loopengSrc}/cc build-image "$@"
    '';
  };
in
{
  checks.loopeng-unit = unit;
  apps.loopeng-build-image = {
    type = "app";
    program = "${buildImage}/bin/loopeng-build-image";
  };
}
