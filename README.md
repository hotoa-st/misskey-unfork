# misskey-unfork

Misskey 포크로 운영하던 인스턴스의 PostgreSQL 데이터베이스를 순정 Misskey로 되돌립니다.

포크 저장소(URL 또는 로컬 경로)를 주면 그 포크가 어느 Misskey 릴리스 위에 만들어졌는지 찾고,
두 리비전의 마이그레이션을 빈 데이터베이스에 실제로 실행해 스키마를 비교한 뒤, 차이를 되돌리는 SQL을 생성합니다.

## 필요한 것

- Node.js 22.18 이상 (TypeScript를 빌드 없이 그대로 실행합니다)
- Docker
- git

## 사용법

```bash
npm install --include=dev

# 1. 포크와 기반 Misskey 버전을 찾아 revert SQL 생성
node src/cli.ts generate https://github.com/example/fork.git --rev v1.2.3

# 2. 무엇이 바뀌고 무엇이 사라지는지 확인 (읽기 전용)
CONN="--docker misskey-db-1 --config /srv/misskey/.config/default.yml"
node src/cli.ts plan $CONN

# 3. 애플리케이션 컨테이너 중지 (DB는 켜둠)
docker compose stop web

# 4. 백업 (apply의 필수 선행 조건)
node src/cli.ts backup $CONN

# 5. 실행
node src/cli.ts apply $CONN

# 6. 확인
node src/cli.ts verify $CONN
```

`plan`은 잃는 데이터(테이블, 컬럼, 삭제되는 행), 다시 쓰이는 데이터, 사라지는 인스턴스 설정을 행 수와 함께 보여줍니다.

인스턴스에 적용됐지만 이 저장소 어느 리비전에도 없는 마이그레이션이 있으면 알려 줍니다.

```bash
node src/cli.ts generate https://github.com/example/fork.git $CONN
```

`--rev`는 인스턴스가 실제로 돌리고 있는 리비전이어야 합니다.
`apply`는 대상 DB의 스키마가 그 리비전과 조금이라도 다르면 거부합니다.
다른 접속 방식(`--db <url>`, `--config <default.yml>`)과 나머지 옵션은 `node src/cli.ts --help`에 있습니다.

## 기반 버전을 찾는 방법

포크 리비전에서 도달할 수 있는 Misskey 릴리스 태그 중 가장 최신 것을 고릅니다.
히스토리가 squash되어 태그를 찾을 수 없으면 마이그레이션 파일 목록을 통해 추정합니다.
`--base <tag>`로 직접 지정할 수도 있습니다.

## 생성되는 것

`generated/<포크>-to-misskey-<버전>/`

```
source.json   포크 마이그레이션이 만드는 스키마
target.json   Misskey 마이그레이션이 만드는 스키마
revert.sql    둘의 차이에서 생성된 SQL
bundle.json   리비전, 탐지 방법, 경고
```

끌어낼 수 없는 것이 있으면 `generate` 명령이 경고를 출력합니다.
출력 디렉토리에 `pre.sql` 파일이나 `post.sql` 파일을 두면 다음 `generate` 때 각각 스키마 변경 앞뒤에 끼워 넣습니다.

## 검증

```bash
node test/e2e.ts <repository> [--rev <ref>] [--fixtures <file.sql>]
```

포크 마이그레이션으로 DB를 만들고, `--fixtures`가 있으면 데이터를 넣고, `plan → backup → apply → verify`를 실제 CLI로 돌린 뒤,
두 릴리스가 공유하는 테이블의 행 수가 유지됐는지와 **대상 Misskey의 TypeORM 러너가 실행할 마이그레이션이 0개인지**를 확인합니다.

실제 인스턴스의 `pg_dump`가 있으면 같은 검사를 그 위에서 돌릴 수 있습니다.

```bash
node test/dump.ts <file.dump> --fork <repository>
```

## 되돌린 뒤

1. 탐지된 Misskey 버전을 **정확히 그 버전으로** 올려 정상 부팅을 확인한 뒤 업그레이드합니다.
2. Redis 큐에 남은 포크 전용 작업은 Misskey가 해석하지 못하므로 비웁니다.
3. 포크 전용 설정 키와 기능은 사라집니다. `plan` 출력과 백업의 JSON에 남습니다.

잘못됐다면 `backup` 명령이 출력해 준 `pg_restore` 명령으로 전체 덤프를 복원할 수 있습니다.

## 라이선스
본 소프트웨어는 [AGPL-3.0](/LICENSE)으로 배포됩니다.

"Misskey"는 [일본에 등록된 상표](https://www.j-platpat.inpit.go.jp/c1801/TR/JP-2022-054788/40/en)입니다. Misskey 및 포크는 [AGPL-3.0으로 배포](https://github.com/misskey-dev/misskey/blob/develop/LICENSE)됩니다.
