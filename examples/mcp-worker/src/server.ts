import {
  McpServer,
  createMcpHandler
} from "@modelcontextprotocol/server";
import { z } from "zod";

interface Env {
  YOUTUBE_API_KEY?: string;
}

const TOOL_NAME = "youtube_video_details";
const YOUTUBE_VIDEOS_ENDPOINT =
  "https://www.googleapis.com/youtube/v3/videos";

const YOUTUBE_TIMEOUT_MS = 8000;

// Internal MCP safety bound.
// This is NOT a documented YouTube API limit.
const MAX_VIDEO_IDS = 25;

const videoIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "Video ID contains unsupported characters"
  );

const errorSchema = z.object({
  code: z.string(),
  category: z.enum([
    "INVALID_INPUT",
    "NOT_FOUND",
    "FORBIDDEN",
    "RATE_LIMITED",
    "DAILY_QUOTA_EXCEEDED",
    "YOUTUBE_API_ERROR",
    "INTERNAL_ERROR"
  ]),
  message: z.string(),
  upstream_http_status: z.number().int().nullable(),
  retryable: z.boolean()
});

const quotaSchema = z.object({
  bucket: z.string(),
  logical_cost: z.number().int().nonnegative(),
  remaining: z.number().int().nullable()
});

const metaSchema = z.object({
  tool_name: z.string(),
  request_id: z.string(),
  fetched_at: z.string(),
  latency_ms: z.number().int().nonnegative(),
  cached: z.boolean()
});

const normalizedVideoSchema = z.object({
  video_id: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  published_at: z.string().nullable(),
  channel_id: z.string().nullable(),
  channel_title: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  category_id: z.string().nullable(),
  default_language: z.string().nullable(),
  default_audio_language: z.string().nullable(),
  duration_iso8601: z.string().nullable(),
  duration_seconds: z.number().int().nullable(),
  view_count: z.string().nullable(),
  like_count: z.string().nullable(),
  comment_count: z.string().nullable(),
  privacy_status: z.string().nullable(),
  embeddable: z.boolean().nullable(),
  made_for_kids: z.boolean().nullable(),
  champs_absents: z.array(z.string())
});

const toolOutputSchema = {
  ok: z.boolean(),
  data: z
    .object({
      videos: z.array(normalizedVideoSchema),
      requested_count: z.number().int().nonnegative(),
      returned_count: z.number().int().nonnegative(),
      missing_video_ids: z.array(z.string())
    })
    .nullable(),
  error: errorSchema.nullable(),
  warnings: z.array(z.string()),
  quota: quotaSchema,
  meta: metaSchema
};

const toolOutputObjectSchema = z.object(toolOutputSchema);
type ToolOutput = z.infer<typeof toolOutputObjectSchema>;

type YouTubeVideoItem = {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelId?: string;
    channelTitle?: string;
    tags?: string[];
    categoryId?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  contentDetails?: {
    duration?: string;
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
  status?: {
    privacyStatus?: string;
    embeddable?: boolean;
    madeForKids?: boolean;
  };
};

type YouTubeVideoItemWithId =
  YouTubeVideoItem & { id: string };

type YouTubeErrorBody = {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{
      reason?: string;
      message?: string;
    }>;
  };
};

function durationToSeconds(
  value?: string
): number | null {
  if (!value) {
    return null;
  }

  const match = value.match(
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
  );

  if (!match) {
    return null;
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);

  return hours * 3600 + minutes * 60 + seconds;
}

function hasVideoId(
  item: YouTubeVideoItem
): item is YouTubeVideoItemWithId {
  return (
    typeof item.id === "string" &&
    item.id.length > 0
  );
}

function normalizeVideo(
  item: YouTubeVideoItemWithId
) {
  const absent: string[] = [];

  const read = <T>(
    value: T | undefined,
    field: string
  ): T | null => {
    if (value === undefined) {
      absent.push(field);
      return null;
    }

    return value;
  };

  const duration =
    item.contentDetails?.duration;

  if (duration === undefined) {
    absent.push("duration_iso8601");
  }

  return {
    video_id: item.id,

    title: read(
      item.snippet?.title,
      "title"
    ),

    description: read(
      item.snippet?.description,
      "description"
    ),

    published_at: read(
      item.snippet?.publishedAt,
      "published_at"
    ),

    channel_id: read(
      item.snippet?.channelId,
      "channel_id"
    ),

    channel_title: read(
      item.snippet?.channelTitle,
      "channel_title"
    ),

    tags: read(
      item.snippet?.tags,
      "tags"
    ),

    category_id: read(
      item.snippet?.categoryId,
      "category_id"
    ),

    default_language: read(
      item.snippet?.defaultLanguage,
      "default_language"
    ),

    default_audio_language: read(
      item.snippet?.defaultAudioLanguage,
      "default_audio_language"
    ),

    duration_iso8601:
      duration ?? null,

    duration_seconds:
      durationToSeconds(duration),

    view_count: read(
      item.statistics?.viewCount,
      "view_count"
    ),

    like_count: read(
      item.statistics?.likeCount,
      "like_count"
    ),

    comment_count: read(
      item.statistics?.commentCount,
      "comment_count"
    ),

    privacy_status: read(
      item.status?.privacyStatus,
      "privacy_status"
    ),

    embeddable: read(
      item.status?.embeddable,
      "embeddable"
    ),

    made_for_kids: read(
      item.status?.madeForKids,
      "made_for_kids"
    ),

    champs_absents: absent
  };
}

function mapYouTubeError(
  status: number,
  body: YouTubeErrorBody
) {
  const reason =
    body.error?.errors?.[0]?.reason ?? "";

  const upstreamMessage =
    body.error?.message ??
    "YouTube API request failed.";

  if (
    reason === "quotaExceeded" ||
    reason === "dailyLimitExceeded"
  ) {
    return {
      code: "YOUTUBE_DAILY_QUOTA",
      category:
        "DAILY_QUOTA_EXCEEDED" as const,
      message:
        "YouTube daily quota is exhausted.",
      upstream_http_status: status,
      retryable: false
    };
  }

  if (
    status === 429 ||
    reason === "rateLimitExceeded" ||
    reason === "userRateLimitExceeded"
  ) {
    return {
      code: "YOUTUBE_RATE_LIMIT",
      category: "RATE_LIMITED" as const,
      message:
        "YouTube temporarily rate-limited the request.",
      upstream_http_status: status,
      retryable: true
    };
  }

  if (
    status === 404 ||
    reason === "videoNotFound"
  ) {
    return {
      code: "YOUTUBE_VIDEO_NOT_FOUND",
      category: "NOT_FOUND" as const,
      message:
        "YouTube did not return the requested resource.",
      upstream_http_status: status,
      retryable: false
    };
  }

  if (status === 403) {
    return {
      code: "YOUTUBE_FORBIDDEN",
      category: "FORBIDDEN" as const,
      message:
        "YouTube refused access to the request.",
      upstream_http_status: status,
      retryable: false
    };
  }

  if (status === 400) {
    return {
      code: "YOUTUBE_INVALID_REQUEST",
      category: "INVALID_INPUT" as const,
      message: upstreamMessage,
      upstream_http_status: status,
      retryable: false
    };
  }

  return {
    code: "YOUTUBE_API_ERROR",
    category: "YOUTUBE_API_ERROR" as const,
    message: upstreamMessage,
    upstream_http_status: status,
    retryable: status >= 500
  };
}

function logRequest(entry: {
  request_id: string;
  tool: string;
  endpoint: string;
  upstream_status: number | null;
  latency_ms: number;
  logical_cost: number;
  ok: boolean;
  error_category: string | null;
}) {
  console.log(JSON.stringify(entry));
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "YouTube Research MCP",
    version: "0.2.1"
  });

  // Temporary non-regression control.
  server.registerTool(
    "hello",
    {
      description:
        "Returns a greeting message",
      inputSchema: {
        name: z.string().optional()
      }
    },
    async ({ name }) => ({
      content: [
        {
          type: "text",
          text:
            `Hello, ${name ?? "World"}!`
        }
      ]
    })
  );

  server.registerTool(
    TOOL_NAME,
    {
      title:
        "YouTube video details",

      description:
        "Retrieve normalized public metadata " +
        "for explicitly known YouTube video IDs. " +
        "Use this instead of search when video IDs " +
        "are already known.",

      inputSchema: {
        video_ids: z
          .array(videoIdSchema)
          .min(1)
          .max(MAX_VIDEO_IDS)
      },

      outputSchema:
        toolOutputSchema,

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true
      }
    },

    async ({ video_ids }) => {
      const started = Date.now();
      const requestId =
        crypto.randomUUID();

      const fetchedAt =
        new Date().toISOString();

      let logicalCost = 0;
      let upstreamStatus:
        number | null = null;

      const makeMeta = () => ({
        tool_name: TOOL_NAME,
        request_id: requestId,
        fetched_at: fetchedAt,
        latency_ms:
          Date.now() - started,
        cached: false
      });

      const finish = (
        output: ToolOutput
      ) => {
        logRequest({
          request_id: requestId,
          tool: TOOL_NAME,
          endpoint: "videos.list",
          upstream_status:
            upstreamStatus,
          latency_ms:
            Date.now() - started,
          logical_cost:
            output.quota.logical_cost,
          ok: output.ok,
          error_category:
            output.error?.category ??
            null
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                JSON.stringify(output)
            }
          ],
          structuredContent:
            output,
          isError: !output.ok
        };
      };

      const makeQuota = () => ({
        bucket: "default",
        // Theoretical logical cost of the
        // YouTube request attempted.
        // It does not claim actual remaining
        // quota or confirmed billing.
        logical_cost: logicalCost,
        remaining: null
      });

      const ids = [
        ...new Set(video_ids)
      ];

      const warnings: string[] = [];

      if (
        ids.length !==
        video_ids.length
      ) {
        warnings.push(
          "Duplicate video IDs were removed " +
          "before the YouTube API call."
        );
      }

      if (!env.YOUTUBE_API_KEY) {
        return finish({
          ok: false,
          data: null,
          error: {
            code:
              "SERVER_CONFIGURATION_ERROR",
            category:
              "INTERNAL_ERROR",
            message:
              "The YouTube API credential " +
              "is not configured on the server.",
            upstream_http_status:
              null,
            retryable: false
          },
          warnings,
          quota: makeQuota(),
          meta: makeMeta()
        });
      }

      const url =
        new URL(
          YOUTUBE_VIDEOS_ENDPOINT
        );

      url.searchParams.set(
        "part",
        [
          "snippet",
          "contentDetails",
          "statistics",
          "status"
        ].join(",")
      );

      url.searchParams.set(
        "id",
        ids.join(",")
      );

      url.searchParams.set(
        "key",
        env.YOUTUBE_API_KEY
      );

      url.searchParams.set(
        "fields",
        [
          "items(",
          "id,",
          "snippet(",
          "title,description,publishedAt,",
          "channelId,channelTitle,tags,",
          "categoryId,defaultLanguage,",
          "defaultAudioLanguage",
          "),",
          "contentDetails(duration),",
          "statistics(",
          "viewCount,likeCount,commentCount",
          "),",
          "status(",
          "privacyStatus,embeddable,madeForKids",
          ")",
          ")"
        ].join("")
      );

      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          YOUTUBE_TIMEOUT_MS
        );

      try {
        logicalCost = 1;

        const response =
          await fetch(url, {
            method: "GET",
            signal:
              controller.signal,
            headers: {
              Accept:
                "application/json"
            }
          });

        upstreamStatus =
          response.status;

        const rawBody =
          await response.text();

        let body:
          | {
              items?:
                YouTubeVideoItem[];
            }
          | YouTubeErrorBody;

        try {
          body =
            JSON.parse(rawBody);
        } catch {
          return finish({
            ok: false,
            data: null,
            error: {
              code:
                "YOUTUBE_INVALID_RESPONSE",
              category:
                "YOUTUBE_API_ERROR",
              message:
                "YouTube returned a response " +
                "that could not be parsed as JSON.",
              upstream_http_status:
                response.status,
              retryable:
                response.status >= 500
            },
            warnings,
            quota: makeQuota(),
            meta: makeMeta()
          });
        }

        if (!response.ok) {
          return finish({
            ok: false,
            data: null,
            error:
              mapYouTubeError(
                response.status,
                body as
                  YouTubeErrorBody
              ),
            warnings,
            quota: makeQuota(),
            meta: makeMeta()
          });
        }

        const items =
          (
            body as {
              items?:
                YouTubeVideoItem[];
            }
          ).items ?? [];

        const malformedItems =
          items.filter(
            (item) =>
              !hasVideoId(item)
          );

        if (
          malformedItems.length > 0
        ) {
          return finish({
            ok: false,
            data: null,
            error: {
              code:
                "YOUTUBE_INVALID_RESPONSE",
              category:
                "YOUTUBE_API_ERROR",
              message:
                "YouTube returned at least one " +
                "video item without an identifier.",
              upstream_http_status:
                response.status,
              retryable: false
            },
            warnings,
            quota: makeQuota(),
            meta: makeMeta()
          });
        }

        const validItems =
          items.filter(hasVideoId);

        const videos =
          validItems.map(
            normalizeVideo
          );

        const returnedIds =
          new Set(
            videos.map(
              (video) =>
                video.video_id
            )
          );

        const missingIds =
          ids.filter(
            (id) =>
              !returnedIds.has(id)
          );

        if (videos.length === 0) {
          return finish({
            ok: false,
            data: {
              videos: [],
              requested_count:
                ids.length,
              returned_count: 0,
              missing_video_ids:
                ids
            },
            error: {
              code:
                "YOUTUBE_NO_VIDEO_RETURNED",
              category:
                "NOT_FOUND",
              message:
                "YouTube returned no accessible " +
                "matching video for the requested IDs.",
              upstream_http_status:
                response.status,
              retryable: false
            },
            warnings: [
              ...warnings,
              "YouTube did not return any requested " +
                "video. The server cannot determine " +
                "whether each ID is invalid, private, " +
                "deleted or otherwise unavailable."
            ],
            quota: makeQuota(),
            meta: makeMeta()
          });
        }

        if (
          missingIds.length > 0
        ) {
          warnings.push(
            "Some requested video IDs were not " +
            "returned by YouTube. No cause is inferred."
          );
        }

        return finish({
          ok: true,
          data: {
            videos,
            requested_count:
              ids.length,
            returned_count:
              videos.length,
            missing_video_ids:
              missingIds
          },
          error: null,
          warnings,
          quota: makeQuota(),
          meta: makeMeta()
        });
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return finish({
            ok: false,
            data: null,
            error: {
              code:
                "YOUTUBE_TIMEOUT",
              category:
                "YOUTUBE_API_ERROR",
              message:
                "The YouTube API request timed out.",
              upstream_http_status:
                upstreamStatus,
              retryable: true
            },
            warnings,
            quota: makeQuota(),
            meta: makeMeta()
          });
        }

        return finish({
          ok: false,
          data: null,
          error: {
            code:
              "INTERNAL_FETCH_ERROR",
            category:
              "INTERNAL_ERROR",
            message:
              "The YouTube request could not be completed.",
            upstream_http_status:
              upstreamStatus,
            retryable: true
          },
          warnings,
          quota: makeQuota(),
          meta: makeMeta()
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  );

  return server;
}

export default {
  fetch(
    request: Request,
    env: Env
  ) {
    const handler = createMcpHandler(
      () => createServer(env)
    );

    return handler.fetch(request);
  }
} satisfies ExportedHandler<Env>;
