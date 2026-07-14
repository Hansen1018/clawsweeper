pragma foreign_keys = on;

insert or ignore into remote_archives(
  id,
  app,
  slug,
  schema_name,
  schema_version,
  schema_hash,
  capabilities,
  last_ingest_at,
  last_sync_at,
  updated_at
) values (
  'gitcrawl/clawsweeper__query_canary',
  'gitcrawl',
  'clawsweeper__query_canary',
  'gitcrawl-cloud-v2',
  2,
  'gitcrawl-query-canary-v1',
  '["gitcrawl.threads.search","gitcrawl.clusters.related","gitcrawl.clusters.list","gitcrawl.clusters.members","gitcrawl.pull_requests.review_context","gitcrawl.coverage"]',
  '2026-07-14T00:02:00.000Z',
  '2026-07-14T00:00:00.000Z',
  '2026-07-14T00:03:00.000Z'
);

insert or ignore into gitcrawl_snapshots(
  archive_id,
  snapshot_id,
  source_sync_at,
  dataset_generated_at,
  coverage_complete,
  created_at,
  activated_at,
  schema_name,
  schema_version,
  schema_hash,
  capabilities,
  hardening_validated_at,
  mutation_token
)
select
  'gitcrawl/clawsweeper__query_canary',
  '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36',
  '2026-07-14T00:00:00.000Z',
  '2026-07-14T00:01:00.000Z',
  1,
  '2026-07-14T00:00:00.000Z',
  '2026-07-14T00:02:00.000Z',
  'gitcrawl-cloud-v2',
  2,
  'gitcrawl-query-canary-v1',
  '["gitcrawl.threads.search","gitcrawl.clusters.related","gitcrawl.clusters.list","gitcrawl.clusters.members","gitcrawl.pull_requests.review_context","gitcrawl.coverage"]',
  '2026-07-14T00:02:00.000Z',
  'gitcrawl-query-canary-v1'
where exists (
  select 1
  from remote_archives
  where id = 'gitcrawl/clawsweeper__query_canary'
    and app = 'gitcrawl'
    and slug = 'clawsweeper__query_canary'
    and schema_name = 'gitcrawl-cloud-v2'
    and schema_version = 2
    and schema_hash = 'gitcrawl-query-canary-v1'
    and capabilities = '["gitcrawl.threads.search","gitcrawl.clusters.related","gitcrawl.clusters.list","gitcrawl.clusters.members","gitcrawl.pull_requests.review_context","gitcrawl.coverage"]'
    and last_ingest_at = '2026-07-14T00:02:00.000Z'
    and last_sync_at = '2026-07-14T00:00:00.000Z'
    and updated_at = '2026-07-14T00:03:00.000Z'
);

insert or ignore into gitcrawl_snapshot_provenance(
  archive_id,
  snapshot_id,
  binding_mode,
  source_sha256,
  created_at
)
select
  'gitcrawl/clawsweeper__query_canary',
  '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36',
  'legacy',
  '',
  '2026-07-14T00:00:00.000Z'
where exists (
  select 1
  from gitcrawl_snapshots
  where archive_id = 'gitcrawl/clawsweeper__query_canary'
    and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
    and coverage_complete = 1
    and mutation_token = 'gitcrawl-query-canary-v1'
);

insert or ignore into gitcrawl_snapshot_repositories(
  archive_id,
  snapshot_id,
  id,
  full_name,
  owner,
  name,
  html_url,
  default_branch,
  updated_at
)
select
  'gitcrawl/clawsweeper__query_canary',
  '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36',
  1,
  'openclaw/clawsweeper-query-canary',
  'openclaw',
  'clawsweeper-query-canary',
  'https://github.com/openclaw/clawsweeper-query-canary',
  'main',
  '2026-07-14T00:00:00.000Z'
where exists (
  select 1
  from gitcrawl_snapshots
  where archive_id = 'gitcrawl/clawsweeper__query_canary'
    and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
    and coverage_complete = 1
    and mutation_token = 'gitcrawl-query-canary-v1'
    and activated_at = '2026-07-14T00:02:00.000Z'
    and hardening_validated_at = '2026-07-14T00:02:00.000Z'
);

with canary(archive_id, snapshot_id) as (
  select
    'gitcrawl/clawsweeper__query_canary',
    '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
  where exists (
    select 1
    from gitcrawl_snapshots
    where archive_id = 'gitcrawl/clawsweeper__query_canary'
      and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
      and coverage_complete = 1
      and mutation_token = 'gitcrawl-query-canary-v1'
      and activated_at = '2026-07-14T00:02:00.000Z'
      and hardening_validated_at = '2026-07-14T00:02:00.000Z'
  )
),
threads(
  id,
  github_id,
  number,
  kind,
  title,
  body,
  html_url,
  updated_at_gh,
  observation_sequence
) as (
  values
    (
      101,
      'query-canary-issue-101',
      101,
      'issue',
      'Provider query canary verification',
      'Deterministic Gitcrawl canary source issue for deployment verification.',
      'https://github.com/openclaw/clawsweeper-query-canary/issues/101',
      '2026-07-14T00:00:10.000Z',
      1
    ),
    (
      102,
      'query-canary-issue-102',
      102,
      'issue',
      'Provider query canary follow-up',
      'Second deterministic canary issue linked to the deployment verification cluster.',
      'https://github.com/openclaw/clawsweeper-query-canary/issues/102',
      '2026-07-14T00:00:20.000Z',
      2
    ),
    (
      103,
      'query-canary-pr-103',
      103,
      'pull_request',
      'Implement provider query canary',
      'Pull request linking deterministic canary data across related and review queries.',
      'https://github.com/openclaw/clawsweeper-query-canary/pull/103',
      '2026-07-14T00:00:30.000Z',
      3
    )
)
insert or ignore into gitcrawl_snapshot_threads(
  archive_id,
  snapshot_id,
  id,
  repo_id,
  github_id,
  number,
  kind,
  state,
  title,
  body,
  author_login,
  author_type,
  html_url,
  labels_json,
  assignees_json,
  is_draft,
  created_at_gh,
  updated_at_gh,
  closed_at_gh,
  merged_at_gh,
  updated_at,
  observation_sequence,
  freshness_order_key
)
select
  canary.archive_id,
  canary.snapshot_id,
  threads.id,
  1,
  threads.github_id,
  threads.number,
  threads.kind,
  'open',
  threads.title,
  threads.body,
  'clawsweeper-canary',
  'Bot',
  threads.html_url,
  '["query-canary"]',
  '[]',
  0,
  '2026-07-14T00:00:00.000Z',
  threads.updated_at_gh,
  '',
  '',
  threads.updated_at_gh,
  threads.observation_sequence,
  threads.updated_at_gh
from canary
cross join threads;

with canary(archive_id, snapshot_id) as (
  select
    'gitcrawl/clawsweeper__query_canary',
    '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
  where exists (
    select 1
    from gitcrawl_snapshots
    where archive_id = 'gitcrawl/clawsweeper__query_canary'
      and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
      and coverage_complete = 1
      and mutation_token = 'gitcrawl-query-canary-v1'
      and activated_at = '2026-07-14T00:02:00.000Z'
      and hardening_validated_at = '2026-07-14T00:02:00.000Z'
  )
),
revisions(
  id,
  thread_id,
  source_updated_at,
  content_hash,
  title_hash,
  body_hash,
  labels_hash,
  observation_sequence
) as (
  values
    (
      1001,
      101,
      '2026-07-14T00:00:10.000Z',
      'query-canary-content-101',
      'query-canary-title-101',
      'query-canary-body-101',
      'query-canary-labels-101',
      1
    ),
    (
      1002,
      102,
      '2026-07-14T00:00:20.000Z',
      'query-canary-content-102',
      'query-canary-title-102',
      'query-canary-body-102',
      'query-canary-labels-102',
      2
    ),
    (
      1003,
      103,
      '2026-07-14T00:00:30.000Z',
      'query-canary-content-103',
      'query-canary-title-103',
      'query-canary-body-103',
      'query-canary-labels-103',
      3
    )
)
insert or ignore into gitcrawl_thread_revisions(
  archive_id,
  snapshot_id,
  id,
  thread_id,
  source_updated_at,
  content_hash,
  title_hash,
  body_hash,
  labels_hash,
  created_at,
  observation_sequence,
  freshness_order_key
)
select
  canary.archive_id,
  canary.snapshot_id,
  revisions.id,
  revisions.thread_id,
  revisions.source_updated_at,
  revisions.content_hash,
  revisions.title_hash,
  revisions.body_hash,
  revisions.labels_hash,
  '2026-07-14T00:01:00.000Z',
  revisions.observation_sequence,
  revisions.source_updated_at
from canary
cross join revisions;

with canary(archive_id, snapshot_id) as (
  select
    'gitcrawl/clawsweeper__query_canary',
    '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
  where exists (
    select 1
    from gitcrawl_snapshots
    where archive_id = 'gitcrawl/clawsweeper__query_canary'
      and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
      and coverage_complete = 1
      and mutation_token = 'gitcrawl-query-canary-v1'
      and activated_at = '2026-07-14T00:02:00.000Z'
      and hardening_validated_at = '2026-07-14T00:02:00.000Z'
  )
),
fingerprints(id, thread_revision_id, fingerprint_hash, fingerprint_slug, simhash64) as (
  values
    (
      2001,
      1001,
      'query-canary-fingerprint-101',
      'provider-query-canary',
      '101'
    ),
    (
      2002,
      1002,
      'query-canary-fingerprint-102',
      'provider-query-canary-follow-up',
      '102'
    ),
    (
      2003,
      1003,
      'query-canary-fingerprint-103',
      'provider-query-canary-fix',
      '103'
    )
)
insert or ignore into gitcrawl_thread_fingerprints(
  archive_id,
  snapshot_id,
  id,
  thread_revision_id,
  algorithm_version,
  fingerprint_hash,
  fingerprint_slug,
  body_token_hash,
  file_set_hash,
  simhash64,
  created_at
)
select
  canary.archive_id,
  canary.snapshot_id,
  fingerprints.id,
  fingerprints.thread_revision_id,
  'query-canary-v1',
  fingerprints.fingerprint_hash,
  fingerprints.fingerprint_slug,
  'query-canary-body-token',
  'query-canary-file-set',
  fingerprints.simhash64,
  '2026-07-14T00:01:00.000Z'
from canary
cross join fingerprints;

with canary(archive_id, snapshot_id) as (
  select
    'gitcrawl/clawsweeper__query_canary',
    '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
  where exists (
    select 1
    from gitcrawl_snapshots
    where archive_id = 'gitcrawl/clawsweeper__query_canary'
      and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
      and coverage_complete = 1
      and mutation_token = 'gitcrawl-query-canary-v1'
      and activated_at = '2026-07-14T00:02:00.000Z'
      and hardening_validated_at = '2026-07-14T00:02:00.000Z'
  )
),
summaries(id, thread_revision_id, key_text, input_hash, output_hash) as (
  values
    (
      3001,
      1001,
      'Provider query canary source issue for deterministic deployment verification.',
      'query-canary-input-101',
      'query-canary-output-101'
    ),
    (
      3002,
      1002,
      'Provider query canary follow-up issue in the deterministic cluster.',
      'query-canary-input-102',
      'query-canary-output-102'
    ),
    (
      3003,
      1003,
      'Pull request review context linked to the deterministic query canary cluster.',
      'query-canary-input-103',
      'query-canary-output-103'
    )
)
insert or ignore into gitcrawl_thread_key_summaries(
  archive_id,
  snapshot_id,
  id,
  thread_revision_id,
  summary_kind,
  prompt_version,
  provider,
  model,
  input_hash,
  output_hash,
  key_text,
  created_at
)
select
  canary.archive_id,
  canary.snapshot_id,
  summaries.id,
  summaries.thread_revision_id,
  'query_canary',
  'v1',
  'migration',
  'deterministic',
  summaries.input_hash,
  summaries.output_hash,
  summaries.key_text,
  '2026-07-14T00:01:00.000Z'
from canary
cross join summaries;

insert or ignore into gitcrawl_cluster_groups(
  archive_id,
  snapshot_id,
  id,
  repo_id,
  stable_key,
  stable_slug,
  status,
  cluster_type,
  representative_thread_id,
  title,
  member_count,
  created_at,
  updated_at,
  closed_at
)
select
  'gitcrawl/clawsweeper__query_canary',
  '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36',
  10,
  1,
  'query-canary-linked-threads',
  'query-canary-linked-threads',
  'active',
  'deployment_verification',
  101,
  'Deterministic deployment query canary',
  3,
  '2026-07-14T00:01:00.000Z',
  '2026-07-14T00:01:00.000Z',
  ''
where exists (
  select 1
  from gitcrawl_snapshots
  where archive_id = 'gitcrawl/clawsweeper__query_canary'
    and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
    and coverage_complete = 1
    and mutation_token = 'gitcrawl-query-canary-v1'
    and activated_at = '2026-07-14T00:02:00.000Z'
    and hardening_validated_at = '2026-07-14T00:02:00.000Z'
);

with canary(archive_id, snapshot_id) as (
  select
    'gitcrawl/clawsweeper__query_canary',
    '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
  where exists (
    select 1
    from gitcrawl_snapshots
    where archive_id = 'gitcrawl/clawsweeper__query_canary'
      and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
      and coverage_complete = 1
      and mutation_token = 'gitcrawl-query-canary-v1'
      and activated_at = '2026-07-14T00:02:00.000Z'
      and hardening_validated_at = '2026-07-14T00:02:00.000Z'
  )
),
memberships(thread_id, role, score) as (
  values
    (101, 'representative', 1.0),
    (102, 'member', 0.98),
    (103, 'member', 0.97)
)
insert or ignore into gitcrawl_cluster_memberships(
  archive_id,
  snapshot_id,
  cluster_id,
  thread_id,
  role,
  state,
  score_to_representative,
  created_at,
  updated_at,
  removed_at
)
select
  canary.archive_id,
  canary.snapshot_id,
  10,
  memberships.thread_id,
  memberships.role,
  'active',
  memberships.score,
  '2026-07-14T00:01:00.000Z',
  '2026-07-14T00:01:00.000Z',
  ''
from canary
cross join memberships;

insert or ignore into gitcrawl_pull_request_details(
  archive_id,
  snapshot_id,
  thread_id,
  repo_id,
  number,
  base_sha,
  head_sha,
  head_ref,
  head_repo_full_name,
  mergeable_state,
  additions,
  deletions,
  changed_files,
  fetched_at,
  updated_at
)
select
  'gitcrawl/clawsweeper__query_canary',
  '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36',
  103,
  1,
  103,
  '1111111111111111111111111111111111111111',
  '2222222222222222222222222222222222222222',
  'query-canary',
  'openclaw/clawsweeper-query-canary',
  'clean',
  12,
  3,
  1,
  '2026-07-14T00:01:00.000Z',
  '2026-07-14T00:01:00.000Z'
where exists (
  select 1
  from gitcrawl_snapshots
  where archive_id = 'gitcrawl/clawsweeper__query_canary'
    and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
    and coverage_complete = 1
    and mutation_token = 'gitcrawl-query-canary-v1'
    and activated_at = '2026-07-14T00:02:00.000Z'
    and hardening_validated_at = '2026-07-14T00:02:00.000Z'
);

insert or ignore into gitcrawl_pull_request_files(
  archive_id,
  snapshot_id,
  thread_id,
  position,
  path,
  status,
  additions,
  deletions,
  changes,
  previous_path,
  fetched_at
)
select
  'gitcrawl/clawsweeper__query_canary',
  '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36',
  103,
  0,
  'deploy/query-canary.json',
  'added',
  12,
  3,
  15,
  '',
  '2026-07-14T00:01:00.000Z'
where exists (
  select 1
  from gitcrawl_snapshots
  where archive_id = 'gitcrawl/clawsweeper__query_canary'
    and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
    and coverage_complete = 1
    and mutation_token = 'gitcrawl-query-canary-v1'
    and activated_at = '2026-07-14T00:02:00.000Z'
    and hardening_validated_at = '2026-07-14T00:02:00.000Z'
);

with canary(archive_id, snapshot_id) as (
  select
    'gitcrawl/clawsweeper__query_canary',
    '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
  where exists (
    select 1
    from gitcrawl_snapshots
    where archive_id = 'gitcrawl/clawsweeper__query_canary'
      and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
      and coverage_complete = 1
      and mutation_token = 'gitcrawl-query-canary-v1'
      and activated_at = '2026-07-14T00:02:00.000Z'
      and hardening_validated_at = '2026-07-14T00:02:00.000Z'
  )
),
coverage(dataset, row_count, eligible_count, covered_count) as (
  values
    ('repositories', 1, 1, 1),
    ('threads', 3, 3, 3),
    ('thread_revisions', 3, 3, 3),
    ('thread_fingerprints', 3, 3, 3),
    ('thread_key_summaries', 3, 3, 3),
    ('cluster_groups', 1, 1, 1),
    ('cluster_memberships', 3, 3, 3),
    ('pull_request_details', 1, 1, 1),
    ('pull_request_files', 1, 1, 1)
)
insert or ignore into gitcrawl_dataset_coverage(
  archive_id,
  snapshot_id,
  dataset,
  row_count,
  eligible_count,
  covered_count,
  max_source_at,
  dataset_generated_at,
  complete,
  mutation_token
)
select
  canary.archive_id,
  canary.snapshot_id,
  coverage.dataset,
  coverage.row_count,
  coverage.eligible_count,
  coverage.covered_count,
  '2026-07-14T00:00:30.000Z',
  '2026-07-14T00:01:00.000Z',
  1,
  'gitcrawl-query-canary-v1'
from canary
cross join coverage;

insert or ignore into gitcrawl_active_snapshots(
  archive_id,
  snapshot_id,
  activated_at
)
select
  'gitcrawl/clawsweeper__query_canary',
  '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36',
  '2026-07-14T00:02:00.000Z'
where exists (
  select 1
  from gitcrawl_snapshots
  where archive_id = 'gitcrawl/clawsweeper__query_canary'
    and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
    and coverage_complete = 1
    and mutation_token = 'gitcrawl-query-canary-v1'
    and activated_at = '2026-07-14T00:02:00.000Z'
    and hardening_validated_at = '2026-07-14T00:02:00.000Z'
);

insert or ignore into gitcrawl_publish_candidates(
  archive_id,
  snapshot_id,
  completed_at
)
select
  'gitcrawl/clawsweeper__query_canary',
  '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36',
  '2026-07-14T00:02:00.000Z'
where exists (
  select 1
  from gitcrawl_active_snapshots
  where archive_id = 'gitcrawl/clawsweeper__query_canary'
    and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
);

insert or ignore into gitcrawl_snapshot_cutovers(
  archive_id,
  snapshot_id,
  cutover_at
)
select
  'gitcrawl/clawsweeper__query_canary',
  '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36',
  '2026-07-14T00:03:00.000Z'
where exists (
  select 1
  from gitcrawl_active_snapshots
  where archive_id = 'gitcrawl/clawsweeper__query_canary'
    and snapshot_id = '9a03e9ec2d365b4f671ce29f1290d19faab979f2e7e01c73088bac6a905f9d36'
);
