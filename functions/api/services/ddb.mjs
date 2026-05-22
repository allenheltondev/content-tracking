import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// One shared client per Lambda execution environment. The Document
// client wraps the low-level DynamoDBClient and handles marshall /
// unmarshall automatically, so route + domain code can pass plain JS
// objects.
//
// Connection reuse is on by default in AWS_NODEJS_CONNECTION_REUSE_ENABLED=1
// land; Lambda Node 24 enables this implicitly.
const baseClient = new DynamoDBClient();

export const ddb = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    // null over undefined: makes nullable optional fields cleaner to
    // round-trip through update operations.
    removeUndefinedValues: true,
  },
});

export const TABLE_NAME = process.env.TABLE_NAME;
